import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { invoke as invokeFixture } from './fixture.mjs';
import {
  completeMcp,
  completeProbePlanStepMcp,
  prepareMcp,
  prepareProbePlanMcp
} from './mcp.mjs';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { validateJsonSchema } from '../../kernel/verify.mjs';

const AT = '2026-07-21T12:00:00.000Z';
const AUTHORITY = 'authority.product.instance';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertClosedNotionWriteOutputs(root) {
  const capabilities = [
    'communications.records.create',
    'communications.records.update',
    'crm.records.create',
    'crm.records.update',
    'meetings.records.create',
    'process.records.create',
    'product.records.create',
    'projects.records.create',
    'projects.records.update',
    'tasks.records.create',
    'tasks.records.update'
  ];
  for (const id of capabilities) {
    const schema = readJson(path.join(root, 'soter', 'capabilities', id + '.json')).outputSchema;
    const record = {
      type: 'record-selftest',
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fields: {},
      version: '1',
      deduplicationKey: 'deduplication-selftest'
    };
    if (schema.properties.record.required.includes('body')) record.body = 'Contained body.';
    const output = {
      record,
      ...(schema.required.includes('created')
        ? { created: true }
        : { changedFields: ['title'] }),
      provenance: {
        provider: 'notion-fixture',
        authority: 'authority.selftest',
        mapping: 'mapping.integration.notion.selftest',
        mappingVersion: '1.0.0',
        sourceKind: 'fixture',
        sourceReferenceFingerprint: 'sha256:' + '0'.repeat(64)
      },
      observedAt: AT
    };
    const valid = validateJsonSchema(output, schema);
    if (valid.length) {
      throw new Error(id + ' closed output rejected its canonical normalized shape: '
        + JSON.stringify(valid));
    }
    for (const [scope, mutate] of [
      ['output', (value) => { value.rawProviderResponse = 'HOSTILE_NOTION_OUTPUT_SENTINEL'; }],
      ['record', (value) => { value.record.rawProviderResponse = 'HOSTILE_NOTION_RECORD_SENTINEL'; }],
      ['provenance', (value) => {
        value.provenance.rawProviderResponse = 'HOSTILE_NOTION_PROVENANCE_SENTINEL';
      }]
    ]) {
      const hostile = structuredClone(output);
      mutate(hostile);
      if (validateJsonSchema(hostile, schema).length === 0) {
        throw new Error(id + ' output schema admitted a raw provider extra in ' + scope + '.');
      }
    }
  }
}

function assertClosedNotionReadOutputs(root) {
  const capabilities = [
    'communications.records.read',
    'crm.records.read',
    'meetings.records.read',
    'process.records.read',
    'product.records.read',
    'projects.records.read',
    'tasks.records.read'
  ];
  for (const id of capabilities) {
    const schema = readJson(path.join(root, 'soter', 'capabilities', id + '.json')).outputSchema;
    const output = {
      records: [{
        type: 'record-selftest',
        id: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        version: 'sha256:' + '0'.repeat(64),
        fields: {},
        identityBinding: {
          state: 'observed',
          requestedIdFingerprint: null
        }
      }],
      provenance: {
        provider: 'provider-selftest',
        authority: 'authority.selftest',
        mapping: 'mapping.integration.notion.selftest',
        mappingVersion: '1.0.0',
        sourceKind: 'fixture',
        sourceReferenceFingerprint: 'sha256:' + '1'.repeat(64)
      },
      observedAt: AT
    };
    const valid = validateJsonSchema(output, schema);
    if (valid.length) {
      throw new Error(id + ' closed output rejected its canonical normalized shape: '
        + JSON.stringify(valid));
    }
    for (const [scope, mutate] of [
      ['output', (value) => {
        value.rawProviderResponse = 'HOSTILE_NOTION_READ_OUTPUT_SENTINEL';
      }],
      ['record', (value) => {
        value.records[0].rawRequestedAlias = 'HOSTILE_NOTION_READ_RECORD_SENTINEL';
      }],
      ['provenance', (value) => {
        value.provenance.rawProviderResponse = 'HOSTILE_NOTION_READ_PROVENANCE_SENTINEL';
      }]
    ]) {
      const hostile = structuredClone(output);
      mutate(hostile);
      if (validateJsonSchema(hostile, schema).length === 0) {
        throw new Error(id + ' output schema admitted an undeclared provider extra in ' + scope + '.');
      }
    }
  }
}

async function expectFailure(label, operation, pattern) {
  try {
    await operation();
  } catch (error) {
    if (pattern.test(error?.message || String(error))) return;
    throw new Error(label + ' failed with the wrong error: ' + (error?.message || String(error)));
  }
  throw new Error(label + ' unexpectedly succeeded.');
}

async function expectFailureKind(label, operation, expectedKind, pattern, forbidden = []) {
  try {
    await operation();
  } catch (error) {
    const message = error?.message || String(error);
    if (error?.kind !== expectedKind
      || !pattern.test(message)
      || forbidden.some((value) => message.includes(value))) {
      throw new Error(
        label + ' failed with the wrong sanitized error classification: '
          + String(error?.kind) + '/' + message
      );
    }
    return;
  }
  throw new Error(label + ' unexpectedly succeeded.');
}

function syntheticProductMapping() {
  return {
    $contract: 'soter://contracts/provider-mapping/v1',
    contractVersion: '1.0.0',
    id: 'mapping.integration.notion.product-records',
    pack: 'integration.notion',
    provider: 'provider.integration.notion.mcp',
    version: '0.1.0',
    contextModel: 'model.context.product.records',
    settingsDefinition: 'settings.integration.notion',
    capabilities: [
      'product.records.read',
      'product.records.create',
      'product.records.update',
      'product.schema.read'
    ],
    recordTypes: [{
      id: 'feature',
      target: 'features',
      capabilities: [
        'product.records.read',
        'product.records.create',
        'product.records.update',
        'product.schema.read'
      ],
      fields: [
        { portable: 'title', provider: 'Name', providerType: 'title', decode: 'scalar' },
        {
          portable: 'status',
          provider: 'Status',
          providerType: 'status',
          valueMapping: 'configured-bijection',
          decode: 'scalar'
        }
      ],
      content: { portable: 'body', provider: 'page-content', providerType: 'markdown' }
    }],
    limitations: [
      'Synthetic mapping exists only inside the contained Notion adapter selftest.'
    ]
  };
}

function syntheticProductFixture() {
  return {
    id: 'fixture.integration.notion.product-records-selftest',
    observedAt: AT,
    data: {
      identity: { kind: 'current-user', providerPersonId: 'person.selftest' },
      records: [{
        type: 'feature',
        id: 'feature.existing',
        version: '1',
        deduplicationKey: 'feature-existing',
        fields: { title: 'Existing feature', status: 'Planned' },
        body: '## Problem\nContained fixture only.'
      }],
      schemas: [{
        recordType: 'feature',
        fields: [
          { id: 'status', writable: true, options: ['Defined', 'Planned'] },
          { id: 'title', writable: true, options: null }
        ]
      }],
      documents: []
    }
  };
}

export async function selftestNotionRecordMappings(root) {
  assertClosedNotionWriteOutputs(root);
  assertClosedNotionReadOutputs(root);
  const crmMapping = readJson(path.join(
    root,
    'soter',
    'integrations',
    'notion',
    'crm-records.mapping.json'
  ));
  const communicationsMapping = readJson(path.join(
    root,
    'soter',
    'integrations',
    'notion',
    'communications-records.mapping.json'
  ));
  const projectsMapping = readJson(path.join(
    root,
    'soter',
    'integrations',
    'notion',
    'projects-records.mapping.json'
  ));
  const tasksMapping = readJson(path.join(
    root,
    'soter',
    'integrations',
    'notion',
    'tasks-records.mapping.json'
  ));
  const meetingsMapping = readJson(path.join(
    root,
    'soter',
    'integrations',
    'notion',
    'meetings-records.mapping.json'
  ));
  const claudeNotionRoute = readJson(path.join(
    root,
    'soter',
    'hosts',
    'claude',
    'adapter.json'
  )).mcpServers.find((server) => server.id === 'notion');
  const expectedClaudeNotionTools = new Map([
    ['fetch', 'Notion:notion-fetch'],
    ['query_data_sources', 'Notion:notion-query-data-sources'],
    ['create_pages', 'Notion:notion-create-pages'],
    ['update_page', 'Notion:notion-update-page']
  ]);
  if (!claudeNotionRoute
    || claudeNotionRoute.toolMappings.length !== expectedClaudeNotionTools.size
    || claudeNotionRoute.toolMappings.some((mapping) => {
      return expectedClaudeNotionTools.get(mapping.logical) !== mapping.native
        || mapping.responseProfile !== 'notion.claude.plugin.v1';
    })) {
    throw new Error(
      'Claude Notion host mapping does not match the declared plugin tool identifiers.'
    );
  }
  const crmFixture = readJson(path.join(
    root,
    'soter',
    'fixtures',
    'providers',
    'notion',
    'workspace-records.json'
  ));
  const processMapping = readJson(path.join(
    root,
    'soter',
    'integrations',
    'notion',
    'process-records.mapping.json'
  ));
  const crmUpdateRecordTypes = crmMapping.recordTypes
    .filter((recordType) => recordType.capabilities.includes('crm.records.update'))
    .map((recordType) => recordType.id)
    .sort();
  if (JSON.stringify(crmUpdateRecordTypes) !== JSON.stringify(['organization', 'person'])) {
    throw new Error(
      'CRM update mapping must support exactly organization and person; Communications channel updates belong to the separate Communications mapping.'
    );
  }
  const crmRead = await invokeFixture({
    capability: 'crm.records.read',
    input: { recordTypes: ['organization'], filters: {}, limit: 2 },
    authority: 'authority.crm.instance',
    fixtures: [],
    mappings: [crmMapping],
    state: crmFixture,
    at: AT
  });
  if (crmRead.records.length < 1
    || crmRead.records.length > 2
    || crmRead.provenance.mapping !== crmMapping.id
    || crmRead.provenance.sourceKind !== 'fixture') {
    throw new Error('Current CRM fixture did not pass through the canonical provider-mapping/v1 boundary.');
  }
  for (const testCase of [
    {
      namespace: 'communications',
      mapping: communicationsMapping,
      authority: 'authority.communications.instance',
      recordType: 'channel'
    },
    {
      namespace: 'projects',
      mapping: projectsMapping,
      authority: 'authority.projects.instance',
      recordType: 'project'
    },
    {
      namespace: 'tasks',
      mapping: tasksMapping,
      authority: 'authority.tasks.instance',
      recordType: 'task'
    },
    {
      namespace: 'meetings',
      mapping: meetingsMapping,
      authority: 'authority.meetings.instance',
      recordType: 'meeting'
    }
  ]) {
    const result = await invokeFixture({
      capability: testCase.namespace + '.records.read',
      input: { recordTypes: [testCase.recordType], filters: {}, limit: 1 },
      authority: testCase.authority,
      fixtures: [],
      mappings: [testCase.mapping],
      state: crmFixture,
      at: AT
    });
    if (result.records.length !== 1
      || result.records[0].type !== testCase.recordType
      || result.provenance.mapping !== testCase.mapping.id) {
      throw new Error(
        'Independent ' + testCase.namespace
          + ' Context did not pass through its own provider mapping boundary.'
      );
    }
  }
  const channelFixtureBase = {
    authority: 'authority.communications.instance',
    fixtures: [],
    mappings: [communicationsMapping],
    state: structuredClone(crmFixture),
    at: AT
  };
  const createdChannel = await invokeFixture({
    ...channelFixtureBase,
    capability: 'communications.records.create',
    input: {
      recordType: 'channel',
      deduplicationKey: 'sha256:156f5a4abc251f35838c5e60c0bca9f92bfe3e4e4690bea826ceed901001a9c0',
      fields: {
        name: 'contained-channel',
        platform: 'Slack',
        workspaceUri: 'soter://communications/workspace/6ffb2b0c160bb9b9a4b87e8976752e05b3edb836b69f866032ce926a27ad24e5',
        workspaceIdentityFingerprint: 'sha256:6ffb2b0c160bb9b9a4b87e8976752e05b3edb836b69f866032ce926a27ad24e5',
        conversationIdentityFingerprint: 'sha256:156f5a4abc251f35838c5e60c0bca9f92bfe3e4e4690bea826ceed901001a9c0',
        hostWorkspaceName: 'Contained workspace',
        visibility: 'private',
        shared: false,
        personUris: [],
        organizationUris: []
      }
    }
  });
  if (!createdChannel.created
    || createdChannel.record.fields.conversationIdentityFingerprint
      !== 'sha256:156f5a4abc251f35838c5e60c0bca9f92bfe3e4e4690bea826ceed901001a9c0'
    || JSON.stringify(createdChannel.record.fields).includes('C999')
    || Object.keys(createdChannel.record.fields).some((key) => key.startsWith('provider'))) {
    throw new Error('Create-scoped immutable channel identity did not pass through the fixture mapping.');
  }
  const communicationsCreateOutput = readJson(path.join(
    root,
    'soter/capabilities/communications.records.create.json'
  )).outputSchema;
  if (validateJsonSchema(createdChannel, communicationsCreateOutput).length) {
    throw new Error('Closed Communications create output rejected the actual normalized fixture result.');
  }
  const createdChannelRead = await invokeFixture({
    ...channelFixtureBase,
    capability: 'communications.records.read',
    input: {
      recordTypes: ['channel'],
      ids: [createdChannel.record.id],
      limit: 1
    }
  });
  if (Object.hasOwn(createdChannelRead.records[0], 'deduplicationKey')
    || validateJsonSchema(
      createdChannelRead,
      readJson(path.join(
        root,
        'soter/capabilities/communications.records.read.json'
      )).outputSchema
    ).length) {
    throw new Error(
      'Fixture create then exact read exposed private write metadata or violated the closed read contract.'
    );
  }
  await expectFailure(
    'immutable channel fixture update',
    () => invokeFixture({
      ...channelFixtureBase,
      capability: 'communications.records.update',
      input: {
        recordType: 'channel',
        id: 'soter-fixture://communications/channel/existing-spell',
        expectedVersion: '1',
        patch: {
          conversationIdentityFingerprint:
            'sha256:256f5a4abc251f35838c5e60c0bca9f92bfe3e4e4690bea826ceed901001a9c0'
        }
      }
    }),
    /update cannot use unmapped or write-scoped field channel\.conversationIdentityFingerprint/
  );
  await expectFailure(
    'raw provider channel field create',
    () => invokeFixture({
      ...channelFixtureBase,
      capability: 'communications.records.create',
      input: {
        recordType: 'channel',
        deduplicationKey: 'sha256:356f5a4abc251f35838c5e60c0bca9f92bfe3e4e4690bea826ceed901001a9c0',
        fields: {
          ...createdChannel.record.fields,
          name: 'hostile-raw-provider-channel',
          providerConversationId: 'HOSTILE_PROVIDER_CONVERSATION_SENTINEL'
        }
      }
    }),
    /cannot use unmapped or write-scoped field channel\.providerConversationId/
  );
  await expectFailure(
    'legacy provider mapping contract',
    () => invokeFixture({
      capability: 'crm.records.read',
      input: { recordTypes: ['organization'], filters: {}, limit: 2 },
      authority: 'authority.crm.instance',
      fixtures: [],
      mappings: [{ ...crmMapping, $contract: 'soter://contracts/provider-mapping/v3' }],
      state: crmFixture,
      at: AT
    }),
    /Expected one fixture provider mapping/
  );

  const processFixtureBase = {
    authority: 'authority.process.instance',
    fixtures: [],
    mappings: [processMapping],
    state: structuredClone(crmFixture),
    at: AT
  };
  const processRead = await invokeFixture({
    ...processFixtureBase,
    capability: 'process.records.read',
    input: {
      recordTypes: ['process'],
      ids: ['soter-fixture://process/definition/wallet-penny-test'],
      limit: 2
    }
  });
  const processSchema = await invokeFixture({
    ...processFixtureBase,
    capability: 'process.schema.read',
    input: { recordType: 'process' }
  });
  const processCreate = await invokeFixture({
    ...processFixtureBase,
    capability: 'process.records.create',
    input: {
      recordType: 'process',
      deduplicationKey: 'contained-process',
      fields: {
        name: 'Contained process',
        status: 'Draft',
        frequency: 'Monthly',
        processLogicOwnerUris: ['soter-fixture://process/role/security-lead'],
        relatedRoleUris: ['soter-fixture://process/role/security-lead']
      },
      body: '# Contained process\n\nFixture-only body.'
    }
  });
  if (processRead.records.length !== 1
    || processRead.records[0].type !== 'process'
    || processSchema.schema.recordType !== 'process'
    || processCreate.created !== true
    || processCreate.record.fields.status !== 'Draft') {
    throw new Error('Process records did not round-trip through the generic fixture translator.');
  }
  const processCreateOutput = readJson(path.join(
    root,
    'soter/capabilities/process.records.create.json'
  )).outputSchema;
  if (validateJsonSchema(processCreate, processCreateOutput).length) {
    throw new Error('Closed Process create output rejected the actual normalized fixture result.');
  }

  const mapping = syntheticProductMapping();
  const fixture = syntheticProductFixture();
  const fixtureBase = {
    authority: AUTHORITY,
    fixtures: [],
    mappings: [mapping],
    state: fixture,
    at: AT
  };
  const read = await invokeFixture({
    ...fixtureBase,
    capability: 'product.records.read',
    input: { recordType: 'feature', filters: { status: 'Planned' }, limit: 1 }
  });
  const schema = await invokeFixture({
    ...fixtureBase,
    capability: 'product.schema.read',
    input: { recordType: 'feature' }
  });
  const created = await invokeFixture({
    ...fixtureBase,
    capability: 'product.records.create',
    input: {
      recordType: 'feature',
      deduplicationKey: 'feature-new',
      fields: { title: 'New feature', status: 'Planned' },
      body: '## Problem\nContained fixture only.'
    }
  });
  const updated = await invokeFixture({
    ...fixtureBase,
    capability: 'product.records.update',
    input: {
      recordType: 'feature',
      id: created.record.id,
      expectedVersion: created.record.version,
      patch: { status: 'Defined' }
    }
  });
  if (read.records.length !== 1
    || schema.schema.recordType !== 'feature'
    || created.created !== true
    || updated.record.fields.status !== 'Defined'
    || updated.provenance.mapping !== mapping.id) {
    throw new Error('Synthetic Product records did not round-trip through the generic fixture translator.');
  }
  const mismatchedMapping = structuredClone(mapping);
  mismatchedMapping.recordTypes[0].capabilities = ['crm.records.read'];
  await expectFailure(
    'cross-namespace record mapping',
    () => invokeFixture({
      ...fixtureBase,
      mappings: [mismatchedMapping],
      capability: 'product.records.read',
      input: { recordType: 'feature', filters: {}, limit: 1 }
    }),
    /does not declare record type feature/
  );

  const settings = {
    'integration.notion': {
      targets: { features: 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      optionMappings: [{
        mapping: 'mapping.integration.notion.product-records',
        recordType: 'feature',
        field: 'status',
        mode: 'exact-bijection',
        entries: [
          { portable: 'Defined', provider: 'Defined' },
          { portable: 'Planned', provider: 'Planned' }
        ]
      }]
    }
  };
  const privateTaskProviderStatus = 'PRIVATE_PROVIDER_TASK_STATUS_SENTINEL';
  const privateTaskProviderContext = 'PRIVATE_PROVIDER_TASK_CONTEXT_SENTINEL';
  const canonicalTaskProjectUri
    = 'https://www.notion.so/cccccccccccccccccccccccccccccccc';
  const canonicalSourceMeetingUris = [
    'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  ];
  const taskProviderPersonUuid = '123e4567-e89b-42d3-a456-426614174000';
  const taskProviderPersonUuidUpper = taskProviderPersonUuid.toUpperCase();
  const taskProviderPersonIds = [
    taskProviderPersonUuid,
    'provider-person.secondary'
  ];
  const taskSettings = {
    'integration.notion': {
      targets: { tasks: 'collection://dddddddddddddddddddddddddddddddd' },
      optionMappings: [
        {
          mapping: 'mapping.integration.notion.tasks-records',
          recordType: 'task',
          field: 'status',
          mode: 'exact-bijection',
          entries: [{ portable: 'To Do', provider: privateTaskProviderStatus }]
        },
        {
          mapping: 'mapping.integration.notion.tasks-records',
          recordType: 'task',
          field: 'context',
          mode: 'exact-bijection',
          entries: [{ portable: 'Project', provider: privateTaskProviderContext }]
        }
      ]
    }
  };
  const taskCreateInput = {
    recordType: 'task',
    deduplicationKey: 'task-connected-array-selftest',
    fields: {
      title: 'Review connected relation arrays',
      status: 'To Do',
      context: 'Project',
      projectUris: [
        'https://www.notion.so/Private-project-slug-CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC?pvs=4'
      ],
      assigneeIds: taskProviderPersonIds,
      sourceMeetingUris: [
        'https://app.notion.com/p/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'https://www.notion.so/Private-meeting-slug-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      ],
      nextActionOn: '2026-07-24'
    }
  };
  const taskCreateRequest = prepareMcp({
    capability: 'tasks.records.create',
    input: taskCreateInput,
    settings: taskSettings,
    mappings: [tasksMapping]
  });
  const taskUpdateInput = {
    recordType: 'task',
    id: 'https://www.notion.so/dddddddddddddddddddddddddddddddd',
    expectedVersion: 'version.connected-array-selftest',
    patch: {
      projectUris: ['cccccccc-cccc-cccc-cccc-cccccccccccc'],
      assigneeIds: taskProviderPersonIds
    }
  };
  const taskUpdateRequest = prepareMcp({
    capability: 'tasks.records.update',
    input: taskUpdateInput,
    settings: taskSettings,
    mappings: [tasksMapping]
  });
  const taskCreateProperties = taskCreateRequest.arguments.pages[0].properties;
  if (taskCreateRequest.tool !== 'create_pages'
    || taskUpdateRequest.tool !== 'update_page'
    || !Array.isArray(taskCreateProperties.Project)
    || !Array.isArray(taskCreateProperties['Assigned To'])
    || !Array.isArray(taskUpdateRequest.arguments.properties.Project)
    || !Array.isArray(taskUpdateRequest.arguments.properties['Assigned To'])
    || taskCreateProperties.Status !== privateTaskProviderStatus
    || taskCreateProperties.Context !== privateTaskProviderContext
    || taskCreateProperties.Project[0] !== canonicalTaskProjectUri
    || fingerprintJson(taskCreateProperties['Source Meetings'])
      !== fingerprintJson(canonicalSourceMeetingUris)
    || fingerprintJson(taskCreateProperties['Assigned To'])
      !== fingerprintJson(taskProviderPersonIds)
    || taskUpdateRequest.arguments.properties.Project[0] !== canonicalTaskProjectUri
    || fingerprintJson(taskUpdateRequest.arguments.properties['Assigned To'])
      !== fingerprintJson(taskProviderPersonIds)
    || JSON.stringify({ taskCreateProperties, taskUpdateRequest }).includes('Private-')) {
    throw new Error(
      'Connected Notion Task writes did not canonicalize relations while preserving person identities.'
    );
  }
  for (const [label, projectUris, pattern] of [
    [
      'duplicate relation aliases',
      [
        canonicalTaskProjectUri,
        'https://app.notion.com/p/cccccccc-cccc-cccc-cccc-cccccccccccc'
      ],
      /duplicate aliases/
    ],
    [
      'foreign relation identity',
      ['https://example.test/cccccccccccccccccccccccccccccccc'],
      /exact Notion page URL or UUID identity/
    ],
    [
      'malformed Notion relation identity',
      ['https://www.notion.so/cccccccccccccccccccccccccccccccc/extra'],
      /exact Notion page URL or UUID identity/
    ]
  ]) {
    await expectFailure(
      label,
      () => prepareMcp({
        capability: 'tasks.records.create',
        input: {
          ...taskCreateInput,
          fields: { ...taskCreateInput.fields, projectUris }
        },
        settings: taskSettings,
        mappings: [tasksMapping]
      }),
      pattern
    );
  }
  for (const [label, assigneeIds] of [
    ['empty provider person identity', ['']],
    ['network-shaped provider person identity', ['https://notion.so/user']],
    ['provider user URI cannot enter write input', ['user://' + taskProviderPersonUuid]],
    ['provider user colon UUID cannot enter write input', ['user:' + taskProviderPersonUuid]],
    ['uppercase provider user colon UUID cannot enter write input', ['USER:' + taskProviderPersonUuid]],
    [
      'compact provider person UUID cannot enter write input',
      [taskProviderPersonUuid.replaceAll('-', '')]
    ],
    ['provider person UUID URN cannot enter write input', ['urn:uuid:' + taskProviderPersonUuid]],
    ['nil provider person UUID cannot enter write input', ['00000000-0000-0000-0000-000000000000']],
    ['uppercase provider person UUID cannot enter write input', [taskProviderPersonUuidUpper]],
    ['duplicate provider person identities', ['provider-person-selftest', 'provider-person-selftest']]
  ]) {
    await expectFailure(
      label,
      () => prepareMcp({
        capability: 'tasks.records.create',
        input: {
          ...taskCreateInput,
          fields: { ...taskCreateInput.fields, assigneeIds }
        },
        settings: taskSettings,
        mappings: [tasksMapping]
      }),
      /provider person identit/
    );
  }
  const taskReadInput = {
    recordTypes: ['task'],
    filters: { status: 'To Do' },
    limit: 1
  };
  const taskReadRequest = prepareMcp({
    capability: 'tasks.records.read',
    input: taskReadInput,
    settings: taskSettings,
    mappings: [tasksMapping]
  });
  const completeTaskRead = (fieldOverrides = {}) => completeMcp({
    capability: 'tasks.records.read',
    authority: 'authority.tasks.instance',
    input: taskReadInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'task',
            __soterId: 'https://www.notion.so/dddddddddddddddddddddddddddddddd',
            __soterFields: JSON.stringify({
              title: 'Review connected relation arrays',
              status: privateTaskProviderStatus,
              context: privateTaskProviderContext,
              projectUris: JSON.stringify([
                'https://www.notion.so/Private-project-slug-CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC'
              ]),
              assigneeIds: JSON.stringify(taskProviderPersonIds),
              nextActionOn: null,
              sourceMeetingUris: JSON.stringify([
                'https://www.notion.so/Private-meeting-b-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
              ]),
              sourceQuotes: JSON.stringify([]),
              sourceSummaryFingerprints: JSON.stringify([]),
              ...fieldOverrides
            })
          }],
          has_more: false
        }
      }
    },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  const taskRead = completeTaskRead();
  const currentSqlPersonTaskRead = completeTaskRead({
    assigneeIds: JSON.stringify(taskProviderPersonIds.map((identity) => {
      return identity === taskProviderPersonUuid
        ? 'user://' + taskProviderPersonUuidUpper
        : identity;
    }))
  });
  assert.deepEqual(
    currentSqlPersonTaskRead.records[0].fields.assigneeIds,
    taskRead.records[0].fields.assigneeIds,
    'Current SQL user:// person identities must decode to canonical opaque identities.'
  );
  assert.equal(
    currentSqlPersonTaskRead.records[0].version,
    taskRead.records[0].version,
    'Equivalent opaque and user:// person identities must seal one canonical record version.'
  );
  const bareUpperUuidTaskRead = completeTaskRead({
    assigneeIds: JSON.stringify(taskProviderPersonIds.map((identity) => {
      return identity === taskProviderPersonUuid
        ? taskProviderPersonUuidUpper
        : identity;
    }))
  });
  assert.deepEqual(
    bareUpperUuidTaskRead.records[0].fields.assigneeIds,
    taskRead.records[0].fields.assigneeIds,
    'Bare provider UUID identities must canonicalize hexadecimal case.'
  );
  assert.equal(
    bareUpperUuidTaskRead.records[0].version,
    taskRead.records[0].version,
    'Bare UUID case aliases must seal one canonical record version.'
  );
  const reorderedTaskRead = completeTaskRead({
    assigneeIds: JSON.stringify([...taskProviderPersonIds].reverse())
  });
  assert.deepEqual(
    reorderedTaskRead.records[0].fields.assigneeIds,
    taskRead.records[0].fields.assigneeIds,
    'Provider person sets must normalize independently of provider response ordering.'
  );
  assert.equal(
    reorderedTaskRead.records[0].version,
    taskRead.records[0].version,
    'Provider person ordering must not change one canonical record version.'
  );
  await expectFailure(
    'returned duplicate relation aliases',
    () => completeTaskRead({
      projectUris: JSON.stringify([
        canonicalTaskProjectUri,
        'https://app.notion.com/p/cccccccccccccccccccccccccccccccc'
      ])
    }),
    /duplicate aliases/
  );
  await expectFailure(
    'returned foreign relation identity',
    () => completeTaskRead({
      projectUris: JSON.stringify([
        'https://example.test/cccccccccccccccccccccccccccccccc'
      ])
    }),
    /exact Notion page URL or UUID identity/
  );
  await expectFailure(
    'returned malformed Notion relation identity',
    () => completeTaskRead({
      projectUris: JSON.stringify([
        'https://www.notion.so/cccccccccccccccccccccccccccccccc/extra'
      ])
    }),
    /exact Notion page URL or UUID identity/
  );
  await expectFailure(
    'returned malformed provider person identity',
    () => completeTaskRead({
      assigneeIds: JSON.stringify(['provider person with spaces'])
    }),
    /provider person identit/
  );
  await expectFailure(
    'returned duplicate bare and user URI provider person aliases',
    () => completeTaskRead({
      assigneeIds: JSON.stringify([
        taskProviderPersonUuidUpper,
        'user://' + taskProviderPersonUuid
      ])
    }),
    /duplicate canonical provider person identit/
  );
  await expectFailure(
    'returned duplicate case aliases for one user URI provider person',
    () => completeTaskRead({
      assigneeIds: JSON.stringify([
        'user://' + taskProviderPersonUuid,
        'user://' + taskProviderPersonUuidUpper
      ])
    }),
    /duplicate canonical provider person identit/
  );
  for (const [label, identity] of [
    ['returned provider person with an arbitrary opaque user suffix', 'user://provider-person-selftest'],
    ['returned provider person with another scheme', 'person://' + taskProviderPersonUuid],
    ['returned provider person with an extra path', 'user://' + taskProviderPersonUuid + '/extra'],
    ['returned provider person with a query', 'user://' + taskProviderPersonUuid + '?role=owner'],
    ['returned provider person with a fragment', 'user://' + taskProviderPersonUuid + '#private'],
    [
      'returned provider person with credentials',
      'user://operator:secret@' + taskProviderPersonUuid
    ],
    ['returned provider person with a compact UUID', 'user://' + taskProviderPersonUuid.replaceAll('-', '')],
    ['returned provider person with a UUID URN', 'user://urn:uuid:' + taskProviderPersonUuid],
    ['returned provider person with a braced UUID', 'user://{' + taskProviderPersonUuid + '}'],
    ['returned provider person with a percent escape', 'user://' + taskProviderPersonUuid + '%2F'],
    ['returned provider person with Unicode payload', 'user://用户'],
    ['returned provider person with the nil UUID', 'user://00000000-0000-0000-0000-000000000000'],
    ['returned provider person with a bare nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['returned provider person with an uppercase bare nil UUID', '00000000-0000-0000-0000-000000000000'.toUpperCase()],
    ['returned provider person with a bare compact UUID', taskProviderPersonUuid.replaceAll('-', '')],
    [
      'returned provider person with an uppercase bare compact UUID',
      taskProviderPersonUuid.replaceAll('-', '').toUpperCase()
    ],
    ['returned provider person with a bare UUID URN', 'urn:uuid:' + taskProviderPersonUuid],
    [
      'returned provider person with an uppercase bare UUID URN',
      ('urn:uuid:' + taskProviderPersonUuid).toUpperCase()
    ],
    ['returned provider person with an empty UUID URN', 'urn:uuid:'],
    ['returned provider person with a malformed UUID URN', 'urn:uuid:not-a-uuid'],
    [
      'returned provider person with an uppercase malformed UUID URN prefix',
      'URN:UUID:not-a-uuid'
    ],
    ['returned provider person with a bare user prefix', 'user:'],
    ['returned provider person with a user colon UUID', 'user:' + taskProviderPersonUuid],
    ['returned provider person with an uppercase user colon UUID', 'USER:' + taskProviderPersonUuid],
    ['returned provider person with a doubled user colon', 'user::' + taskProviderPersonUuid],
    ['returned provider person with one user slash', 'user:/' + taskProviderPersonUuid],
    ['returned provider person with extra user slashes', 'user:////' + taskProviderPersonUuid],
    ['returned provider person with an empty authority', 'user:///123e4567-e89b-42d3-a456-426614174000'],
    ['returned provider person with a non-canonical scheme', 'USER://' + taskProviderPersonUuid]
  ]) {
    await expectFailure(
      label,
      () => completeTaskRead({
        assigneeIds: JSON.stringify([identity])
      }),
      /provider person identit/
    );
  }
  const taskSchemaInput = { recordType: 'task' };
  const taskSchemaProviderResult = {
    metadata: { type: 'data_source' },
    text: '<data-source url="{{collection://dddddddddddddddddddddddddddddddd}}">'
      + '<data-source-state>'
      + JSON.stringify({
        schema: {
          Name: { name: 'Name', type: 'title' },
          Status: {
            name: 'Status',
            type: 'status',
            groups: {
              to_do: [{ name: privateTaskProviderStatus }],
              in_progress: [],
              complete: []
            }
          },
          Context: {
            name: 'Context',
            type: 'select',
            options: [{ name: privateTaskProviderContext }]
          },
          Project: { name: 'Project', type: 'relation' },
          'Assigned To': { name: 'Assigned To', type: 'person' },
          'Next Action': { name: 'Next Action', type: 'date' },
          'Source Meetings': { name: 'Source Meetings', type: 'relation' },
          Grounding: { name: 'Grounding', type: 'text' },
          'Summary Fingerprints': {
            name: 'Summary Fingerprints',
            type: 'text'
          }
        }
      })
      + '</data-source-state></data-source>'
  };
  const taskSchema = completeMcp({
    capability: 'tasks.schema.read',
    authority: 'authority.tasks.instance',
    input: taskSchemaInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: taskSchemaProviderResult
      }
    },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  const directClaudeTaskSchema = completeMcp({
    capability: 'tasks.schema.read',
    authority: 'authority.tasks.instance',
    input: taskSchemaInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: taskSchemaProviderResult,
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  assert.deepEqual(
    directClaudeTaskSchema,
    taskSchema,
    'Direct Claude Notion data-source state must normalize identically to the governed wrapper.'
  );
  await expectFailure(
    'direct Claude Notion data-source with an undeclared top-level field',
    () => completeMcp({
      capability: 'tasks.schema.read',
      authority: 'authority.tasks.instance',
      input: taskSchemaInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        ...taskSchemaProviderResult,
        rawProviderResponse: 'HOSTILE_DIRECT_NOTION_DATA_SOURCE_SENTINEL'
      },
      at: AT,
      mappings: [tasksMapping],
      settings: taskSettings
    }),
    /structured or JSON text result|invalid direct Claude result/
  );
  const taskSchemaFields = new Map(
    taskSchema.schema.fields.map((field) => [field.id, field])
  );
  if (taskReadRequest.arguments.data.params?.[0] !== privateTaskProviderStatus
    || taskRead.records[0].fields.status !== 'To Do'
    || taskRead.records[0].fields.context !== 'Project'
    || fingerprintJson(taskRead.records[0].fields.projectUris)
      !== fingerprintJson([canonicalTaskProjectUri])
    || fingerprintJson(taskRead.records[0].fields.sourceMeetingUris)
      !== fingerprintJson(canonicalSourceMeetingUris)
    || fingerprintJson(taskRead.records[0].fields.assigneeIds)
      !== fingerprintJson(taskProviderPersonIds)
    || JSON.stringify(taskRead).includes('Private-')
    || JSON.stringify(taskRead).includes(privateTaskProviderStatus)
    || JSON.stringify(taskRead).includes(privateTaskProviderContext)
    || !taskSchemaFields.get('status')?.options?.includes('To Do')
    || !taskSchemaFields.get('context')?.options?.includes('Project')
    || JSON.stringify(taskSchema).includes(privateTaskProviderStatus)
    || JSON.stringify(taskSchema).includes(privateTaskProviderContext)) {
    throw new Error(
      'Connected Notion choice values did not translate bidirectionally without provider-label disclosure.'
    );
  }
  const processUriAlias
    = 'https://app.notion.com/p/abababab-abab-abab-abab-abababababab?private=query-sentinel';
  const canonicalProcessUri
    = 'https://www.notion.so/abababababababababababababababab';
  const processRunSettings = {
    'integration.notion': {
      targets: {
        'process-runs': 'collection://12121212121212121212121212121212'
      }
    }
  };
  const processRunInput = {
    recordTypes: ['process-run'],
    filters: { processUri: processUriAlias },
    limit: 1
  };
  const processRunRequest = prepareMcp({
    capability: 'process.records.read',
    input: processRunInput,
    settings: processRunSettings,
    mappings: [processMapping]
  });
  assert.deepEqual(
    processRunRequest.arguments.data.params,
    [canonicalProcessUri],
    'Mapped relation filters must send only the canonical portable Notion identity.'
  );
  assert.equal(
    JSON.stringify(processRunRequest).includes('private=query-sentinel'),
    false,
    'Mapped relation filters must not copy a query-bearing alias into the provider request.'
  );
  const processRunRead = completeMcp({
    capability: 'process.records.read',
    authority: 'authority.process.instance',
    input: processRunInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'process-run',
            __soterId: 'https://www.notion.so/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
            __soterFields: JSON.stringify({
              name: 'Contained process run',
              processUri: 'https://www.notion.so/Process-abababababababababababababababab',
              state: null,
              outcome: null,
              observedClaims: null
            })
          }],
          has_more: false
        }
      }
    },
    at: AT,
    mappings: [processMapping],
    settings: processRunSettings
  });
  assert.equal(
    processRunRead.records[0].fields.processUri,
    canonicalProcessUri,
    'Mapped relation post-read checks must compare the same canonical identity basis.'
  );
  const missingTaskOptionSettings = structuredClone(taskSettings);
  missingTaskOptionSettings['integration.notion'].optionMappings
    = missingTaskOptionSettings['integration.notion'].optionMappings.slice(1);
  await expectFailure(
    'missing exact task option mapping',
    () => prepareMcp({
      capability: 'tasks.records.create',
      input: taskCreateInput,
      settings: missingTaskOptionSettings,
      mappings: [tasksMapping]
    }),
    /does not map one required portable choice field/
  );
  const duplicateTaskOptionSettings = structuredClone(taskSettings);
  duplicateTaskOptionSettings['integration.notion'].optionMappings.push(
    structuredClone(duplicateTaskOptionSettings['integration.notion'].optionMappings[0])
  );
  await expectFailure(
    'duplicate task option mapping scope',
    () => prepareMcp({
      capability: 'tasks.records.create',
      input: taskCreateInput,
      settings: duplicateTaskOptionSettings,
      mappings: [tasksMapping]
    }),
    /duplicate field scope/
  );
  const unknownTaskOptionInput = structuredClone(taskCreateInput);
  unknownTaskOptionInput.fields.status = 'Portable status outside the exact map';
  await expectFailure(
    'unmapped portable task option',
    () => prepareMcp({
      capability: 'tasks.records.create',
      input: unknownTaskOptionInput,
      settings: taskSettings,
      mappings: [tasksMapping]
    }),
    /does not map one exact choice value/
  );
  const ambiguousTaskOptionSettings = structuredClone(taskSettings);
  ambiguousTaskOptionSettings['integration.notion'].optionMappings[0].entries.push({
    portable: 'Backlog',
    provider: privateTaskProviderStatus
  });
  await expectFailure(
    'ambiguous task option reverse mapping',
    () => prepareMcp({
      capability: 'tasks.records.create',
      input: taskCreateInput,
      settings: ambiguousTaskOptionSettings,
      mappings: [tasksMapping]
    }),
    /must be exact bijections/
  );
  const privateOrganizationTagA = 'PRIVATE_PROVIDER_ORGANIZATION_TAG_A_SENTINEL';
  const privateOrganizationTagB = 'PRIVATE_PROVIDER_ORGANIZATION_TAG_B_SENTINEL';
  const organizationSettings = {
    'integration.notion': {
      targets: {
        organizations: 'collection://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      },
      optionMappings: [{
        mapping: 'mapping.integration.notion.crm-records',
        recordType: 'organization',
        field: 'tags',
        mode: 'exact-bijection',
        entries: [
          { portable: 'Portable Alpha', provider: privateOrganizationTagA },
          { portable: 'Portable Beta', provider: privateOrganizationTagB }
        ]
      }]
    }
  };
  const organizationCreateInput = {
    recordType: 'organization',
    deduplicationKey: 'organization-option-array-selftest',
    fields: {
      name: 'Option array selftest',
      tags: ['Portable Alpha', 'Portable Beta']
    }
  };
  const organizationCreateRequest = prepareMcp({
    capability: 'crm.records.create',
    input: organizationCreateInput,
    settings: organizationSettings,
    mappings: [crmMapping]
  });
  if (fingerprintJson(JSON.parse(organizationCreateRequest.arguments.pages[0].properties.Tags))
    !== fingerprintJson([privateOrganizationTagA, privateOrganizationTagB])) {
    throw new Error('Connected Notion multi-select create did not translate every exact item.');
  }
  const organizationRead = completeMcp({
    capability: 'crm.records.read',
    authority: 'authority.crm.instance',
    input: {
      recordTypes: ['organization'],
      filters: {},
      limit: 1
    },
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'organization',
            __soterId: 'https://www.notion.so/efefefefefefefefefefefefefefefef',
            __soterFields: JSON.stringify({
              name: 'Option array selftest',
              organizationType: null,
              tags: JSON.stringify([
                privateOrganizationTagA,
                privateOrganizationTagB
              ]),
              website: null,
              twitter: null,
              projectUris: JSON.stringify([]),
              contactUris: JSON.stringify([])
            })
          }],
          has_more: false
        }
      }
    },
    at: AT,
    mappings: [crmMapping],
    settings: organizationSettings
  });
  if (fingerprintJson(organizationRead.records[0].fields.tags)
      !== fingerprintJson(['Portable Alpha', 'Portable Beta'])
    || JSON.stringify(organizationRead).includes(privateOrganizationTagA)
    || JSON.stringify(organizationRead).includes(privateOrganizationTagB)) {
    throw new Error(
      'Connected Notion multi-select read did not normalize every item without disclosure.'
    );
  }
  const privateTaskCreatePropertyMarker = 'PRIVATE_NOTION_CREATE_PROPERTY_SENTINEL';
  const taskCreateProviderResult = {
    pages: [{
      id: 'dddddddddddddddddddddddddddddddd',
      properties: { privateProviderProperty: privateTaskCreatePropertyMarker },
      url: 'https://www.notion.so/dddddddddddddddddddddddddddddddd'
    }]
  };
  const codexTaskCreate = completeMcp({
    capability: 'tasks.records.create',
    authority: 'authority.tasks.instance',
    input: taskCreateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: { structuredContent: { result: taskCreateProviderResult } },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  const claudeTaskCreate = completeMcp({
    capability: 'tasks.records.create',
    authority: 'authority.tasks.instance',
    input: taskCreateInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: taskCreateProviderResult,
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  const codexTaskUpdate = completeMcp({
    capability: 'tasks.records.update',
    authority: 'authority.tasks.instance',
    input: taskUpdateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: { result: { id: 'dddddddddddddddddddddddddddddddd' } }
    },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  const claudeTaskUpdate = completeMcp({
    capability: 'tasks.records.update',
    authority: 'authority.tasks.instance',
    input: taskUpdateInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: { page_id: 'dddddddddddddddddddddddddddddddd' },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  if (fingerprintJson(codexTaskCreate) !== fingerprintJson(claudeTaskCreate)
    || fingerprintJson(codexTaskUpdate) !== fingerprintJson(claudeTaskUpdate)
    || !Array.isArray(claudeTaskCreate.record.fields.projectUris)
    || !Array.isArray(claudeTaskCreate.record.fields.assigneeIds)
    || !Array.isArray(claudeTaskUpdate.record.fields.projectUris)
    || !Array.isArray(claudeTaskUpdate.record.fields.assigneeIds)
    || JSON.stringify({ codexTaskCreate, claudeTaskCreate })
      .includes(privateTaskCreatePropertyMarker)) {
    throw new Error(
      'Codex and Claude Notion envelopes did not normalize one exact typed Task request identically.'
    );
  }
  const liveShapedTaskReadBack = completeTaskRead({
    title: taskCreateInput.fields.title,
    status: privateTaskProviderStatus,
    context: privateTaskProviderContext,
    projectUris: JSON.stringify([canonicalTaskProjectUri]),
    assigneeIds: JSON.stringify(taskProviderPersonIds.map((identity) => {
      return identity === taskProviderPersonUuid
        ? 'user://' + taskProviderPersonUuidUpper
        : identity;
    })),
    sourceMeetingUris: JSON.stringify(canonicalSourceMeetingUris),
    nextActionOn: taskCreateInput.fields.nextActionOn
  });
  assert.equal(
    liveShapedTaskReadBack.records[0].id,
    codexTaskCreate.record.id,
    'Live-shaped Task read-back must preserve the exact created record identity.'
  );
  for (const [field, expected] of Object.entries(codexTaskCreate.record.fields)) {
    assert.deepEqual(
      liveShapedTaskReadBack.records[0].fields[field],
      expected,
      'Live-shaped Task read-back did not preserve canonical created field ' + field + '.'
    );
  }
  const currentAppTaskCreate = completeMcp({
    capability: 'tasks.records.create',
    authority: 'authority.tasks.instance',
    input: taskCreateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          pages: [{
            id: 'dddddddddddddddddddddddddddddddd',
            url: 'https://app.notion.com/p/dddddddd-dddd-dddd-dddd-dddddddddddd'
          }]
        }
      }
    },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  const currentAppTaskUpdateInput = {
    ...taskUpdateInput,
    id: 'https://app.notion.com/p/dddddddddddddddddddddddddddddddd'
  };
  const currentAppTaskUpdateRequest = prepareMcp({
    capability: 'tasks.records.update',
    input: currentAppTaskUpdateInput,
    settings: taskSettings,
    mappings: [tasksMapping]
  });
  const currentAppTaskUpdate = completeMcp({
    capability: 'tasks.records.update',
    authority: 'authority.tasks.instance',
    input: currentAppTaskUpdateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          id: 'dddddddddddddddddddddddddddddddd',
          url: 'https://app.notion.com/dddddddd-dddd-dddd-dddd-dddddddddddd'
        }
      }
    },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  if (currentAppTaskCreate.record.id
      !== 'https://www.notion.so/dddddddddddddddddddddddddddddddd'
    || currentAppTaskUpdateRequest.arguments.page_id
      !== 'dddddddddddddddddddddddddddddddd'
    || currentAppTaskUpdate.record.id
      !== 'https://www.notion.so/dddddddddddddddddddddddddddddddd'
    || fingerprintJson(currentAppTaskCreate.record.fields.projectUris)
      !== fingerprintJson([canonicalTaskProjectUri])
    || fingerprintJson(currentAppTaskUpdate.record.fields.projectUris)
      !== fingerprintJson([canonicalTaskProjectUri])
    || JSON.stringify({ currentAppTaskCreate, currentAppTaskUpdate }).includes('Private-')) {
    throw new Error(
      'Current app.notion.com create/update identities did not normalize to portable canonical records.'
    );
  }
  const currentAppDocumentInput = {
    uri: 'https://app.notion.com/p/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    expectedTitle: 'Connected policy'
  };
  const currentAppDocumentReadRequest = prepareMcp({
    capability: 'documents.content.read',
    input: currentAppDocumentInput,
    settings: {},
    mappings: []
  });
  const currentAppDocumentProviderResult = {
    metadata: { type: 'page' },
    title: currentAppDocumentInput.expectedTitle,
    url: 'https://app.notion.com/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    text: '<page id="eeee"><properties></properties>\nExact policy body.\n</page>'
  };
  const currentAppDocumentRead = completeMcp({
    capability: 'documents.content.read',
    authority: 'authority.documents.instance',
    input: currentAppDocumentInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: currentAppDocumentProviderResult
      }
    },
    at: AT,
    mappings: [],
    settings: {}
  });
  const directClaudeDocumentRead = completeMcp({
    capability: 'documents.content.read',
    authority: 'authority.documents.instance',
    input: currentAppDocumentInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: currentAppDocumentProviderResult,
    at: AT,
    mappings: [],
    settings: {}
  });
  assert.deepEqual(
    directClaudeDocumentRead,
    currentAppDocumentRead,
    'Direct Claude Notion page data must normalize identically to the governed wrapper.'
  );
  await expectFailure(
    'direct Claude Notion page with an undeclared top-level field',
    () => completeMcp({
      capability: 'documents.content.read',
      authority: 'authority.documents.instance',
      input: currentAppDocumentInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        ...currentAppDocumentProviderResult,
        rawProviderResponse: 'HOSTILE_DIRECT_NOTION_PAGE_SENTINEL'
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    /structured or JSON text result|invalid direct Claude result/
  );
  await expectFailure(
    'conflicting current app document read identities',
    () => completeMcp({
      capability: 'documents.content.read',
      authority: 'authority.documents.instance',
      input: currentAppDocumentInput,
      responseProfile: 'notion.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            metadata: { type: 'page' },
            title: currentAppDocumentInput.expectedTitle,
            url: 'https://app.notion.com/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            id: 'ffffffffffffffffffffffffffffffff',
            text: '<page id="eeee"><properties></properties>\nExact policy body.\n</page>'
          }
        }
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    /conflicting provider page identities/
  );
  const currentAppDocumentUpdateInput = {
    ...currentAppDocumentInput,
    expectedBodyFingerprint: 'sha256:' + 'e'.repeat(64),
    updates: [{
      id: 'update.current-app-document',
      oldText: 'Exact policy body.',
      newText: 'Updated exact policy body.',
      replaceAllMatches: false
    }]
  };
  const currentAppDocumentUpdateRequest = prepareMcp({
    capability: 'documents.content.update',
    input: currentAppDocumentUpdateInput,
    settings: {},
    mappings: []
  });
  const currentAppDocumentUpdate = completeMcp({
    capability: 'documents.content.update',
    authority: 'authority.documents.instance',
    input: currentAppDocumentUpdateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          url: 'https://app.notion.com/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
        }
      }
    },
    at: AT,
    mappings: [],
    settings: {}
  });
  const directClaudeDocumentUpdate = completeMcp({
    capability: 'documents.content.update',
    authority: 'authority.documents.instance',
    input: currentAppDocumentUpdateInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: { page_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    at: AT,
    mappings: [],
    settings: {}
  });
  assert.deepEqual(
    directClaudeDocumentUpdate,
    currentAppDocumentUpdate,
    'Direct Claude Notion document updates must normalize identically to the governed wrapper.'
  );
  if (currentAppDocumentReadRequest.arguments.id
      !== 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    || currentAppDocumentRead.document.uri !== currentAppDocumentInput.uri
    || currentAppDocumentUpdateRequest.arguments.page_id
      !== 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    || currentAppDocumentUpdate.document.uri !== currentAppDocumentInput.uri) {
    throw new Error(
      'Current app.notion.com document read/update did not preserve one exact requested identity.'
    );
  }
  await expectFailure(
    'conflicting current app document update identities',
    () => completeMcp({
      capability: 'documents.content.update',
      authority: 'authority.documents.instance',
      input: currentAppDocumentUpdateInput,
      responseProfile: 'notion.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            url: 'https://app.notion.com/ffffffffffffffffffffffffffffffff'
          }
        }
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    /conflicting provider page identities/
  );
  const privateDirectIdentityMarker = 'PRIVATE_DIRECT_NOTION_IDENTITY_SENTINEL';
  const directClaudeSelfPayload = {
    metadata: { type: 'self' },
    title: '',
    url: '',
    text: '',
    self: {
      workspace: { id: 'workspace.direct-selftest' },
      user: { id: 'user.direct-selftest' },
      current_tool_access: {
        fetch: { status: 'available' },
        query_data_sources: { status: 'limited_free_trial' }
      }
    }
  };
  const directClaudeIdentity = completeMcp({
    capability: 'workspace.identity.read',
    authority: 'authority.notion.provider',
    input: { identity: 'current-user' },
    responseProfile: 'notion.claude.plugin.v1',
    response: directClaudeSelfPayload,
    at: AT,
    mappings: [],
    settings: {}
  });
  if (directClaudeIdentity.identity.providerPersonId !== 'user.direct-selftest'
    || JSON.stringify(directClaudeIdentity).includes(privateDirectIdentityMarker)) {
    throw new Error(
      'Direct Claude Notion identity did not normalize without private provider prose.'
    );
  }
  const wrappedUuidIdentity = completeMcp({
    capability: 'workspace.identity.read',
    authority: 'authority.notion.provider',
    input: { identity: 'current-user' },
    responseProfile: 'notion.claude.plugin.v1',
    response: {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        user: { id: 'user://' + taskProviderPersonUuid }
      }
    },
    at: AT,
    mappings: [],
    settings: {}
  });
  const bareUuidIdentity = completeMcp({
    capability: 'workspace.identity.read',
    authority: 'authority.notion.provider',
    input: { identity: 'current-user' },
    responseProfile: 'notion.claude.plugin.v1',
    response: {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        user: { id: taskProviderPersonUuidUpper }
      }
    },
    at: AT,
    mappings: [],
    settings: {}
  });
  assert.deepEqual(
    wrappedUuidIdentity,
    bareUuidIdentity,
    'Workspace identity reads must canonicalize exact user:// UUID values before fingerprinting.'
  );
  await expectFailure(
    'workspace identity with arbitrary user URI payload',
    () => completeMcp({
      capability: 'workspace.identity.read',
      authority: 'authority.notion.provider',
      input: { identity: 'current-user' },
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        ...directClaudeSelfPayload,
        self: {
          ...directClaudeSelfPayload.self,
          user: { id: 'user://provider-person-selftest' }
        }
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    /provider person identit|user:\/\/ UUID identity/
  );
  for (const [label, providerPersonId] of [
    ['workspace identity with a bare nil UUID', '00000000-0000-0000-0000-000000000000'],
    [
      'workspace identity with an uppercase bare nil UUID',
      '00000000-0000-0000-0000-000000000000'.toUpperCase()
    ],
    [
      'workspace identity with a bare compact UUID',
      taskProviderPersonUuid.replaceAll('-', '')
    ],
    [
      'workspace identity with an uppercase bare compact UUID',
      taskProviderPersonUuid.replaceAll('-', '').toUpperCase()
    ],
    [
      'workspace identity with a bare UUID URN',
      'urn:uuid:' + taskProviderPersonUuid
    ],
    [
      'workspace identity with an uppercase bare UUID URN',
      ('urn:uuid:' + taskProviderPersonUuid).toUpperCase()
    ],
    [
      'workspace identity with an empty UUID URN',
      'urn:uuid:'
    ],
    [
      'workspace identity with a malformed UUID URN',
      'urn:uuid:not-a-uuid'
    ],
    [
      'workspace identity with an uppercase malformed UUID URN prefix',
      'URN:UUID:not-a-uuid'
    ],
    [
      'workspace identity with a bare user prefix',
      'user:'
    ],
    [
      'workspace identity with a user colon UUID',
      'user:' + taskProviderPersonUuid
    ],
    [
      'workspace identity with an uppercase user colon UUID',
      'USER:' + taskProviderPersonUuid
    ],
    [
      'workspace identity with a doubled user colon',
      'user::' + taskProviderPersonUuid
    ],
    [
      'workspace identity with one user slash',
      'user:/' + taskProviderPersonUuid
    ],
    [
      'workspace identity with extra user slashes',
      'user:////' + taskProviderPersonUuid
    ]
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'workspace.identity.read',
        authority: 'authority.notion.provider',
        input: { identity: 'current-user' },
        responseProfile: 'notion.claude.plugin.v1',
        response: {
          ...directClaudeSelfPayload,
          self: {
            ...directClaudeSelfPayload.self,
            user: { id: providerPersonId }
          }
        },
        at: AT,
        mappings: [],
        settings: {}
      }),
      /provider person identit|user:\/\/ UUID identity/
    );
  }
  const observedDirectClaudeIdentity = completeMcp({
    capability: 'workspace.identity.read',
    authority: 'authority.notion.provider',
    input: { identity: 'current-user' },
    responseProfile: 'notion.claude.plugin.v1',
    response: {
      ...directClaudeSelfPayload,
      self: {
        workspace: {
          id: 'workspace.direct-selftest',
          name: privateDirectIdentityMarker
        },
        user: {
          email: privateDirectIdentityMarker + '@example.test',
          id: 'user.direct-selftest',
          name: privateDirectIdentityMarker,
          type: 'person'
        },
        current_tool_access: {
          fetch: {
            status: 'upgrade_required',
            upgrade_url: 'https://example.test/' + privateDirectIdentityMarker
          }
        }
      }
    },
    at: AT,
    mappings: [],
    settings: {}
  });
  assert.deepEqual(
    observedDirectClaudeIdentity,
    directClaudeIdentity,
    'Observed optional Claude identity strings must be accepted and discarded after normalization.'
  );
  const privateRateLimitMarker = 'PRIVATE_NOTION_RATE_LIMIT_PROSE_SENTINEL';
  await expectFailureKind(
    'exact Codex Notion rate-limit error',
    () => completeMcp({
      capability: 'workspace.identity.read',
      authority: 'authority.notion.provider',
      input: { identity: 'current-user' },
      responseProfile: 'notion.codex.connector.v1',
      response: {
        isError: true,
        structuredContent: { error_code: 'RATE_LIMITED' },
        content: [{ type: 'text', text: privateRateLimitMarker }]
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    'rate-limit',
    /returned an error result/,
    [privateRateLimitMarker]
  );
  await expectFailureKind(
    'Claude Notion rate-limit-shaped error',
    () => completeMcp({
      capability: 'workspace.identity.read',
      authority: 'authority.notion.provider',
      input: { identity: 'current-user' },
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        is_error: true,
        structuredContent: { error_code: 'RATE_LIMITED' },
        content: [{ type: 'text', text: privateRateLimitMarker }]
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    'unknown',
    /returned an error result/,
    [privateRateLimitMarker]
  );
  await expectFailureKind(
    'unknown Codex Notion error containing rate-limit prose',
    () => completeMcp({
      capability: 'workspace.identity.read',
      authority: 'authority.notion.provider',
      input: { identity: 'current-user' },
      responseProfile: 'notion.codex.connector.v1',
      response: {
        isError: true,
        structuredContent: { error_code: 'UNKNOWN' },
        content: [{
          type: 'text',
          text: 'rate limit ' + privateRateLimitMarker
        }]
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    'unknown',
    /returned an error result/,
    [privateRateLimitMarker]
  );
  await expectFailure(
    'contradictory successful Codex response with an error code',
    () => completeMcp({
      capability: 'workspace.identity.read',
      authority: 'authority.notion.provider',
      input: { identity: 'current-user' },
      responseProfile: 'notion.codex.connector.v1',
      response: {
        isError: false,
        structuredContent: {
          result: directClaudeSelfPayload,
          error_code: 'RATE_LIMITED'
        }
      },
      at: AT,
      mappings: [],
      settings: {}
    }),
    /invalid Codex structured result/
  );
  const codexContentIdentity = completeMcp({
    capability: 'workspace.identity.read',
    authority: 'authority.notion.provider',
    input: { identity: 'current-user' },
    responseProfile: 'notion.codex.connector.v1',
    response: {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(directClaudeSelfPayload) }]
    },
    at: AT,
    mappings: [],
    settings: {}
  });
  assert.deepEqual(
    codexContentIdentity,
    directClaudeIdentity,
    'The observed exact Codex JSON content branch must normalize identically.'
  );
  for (const [label, flag] of [
    ['string Codex isError state', { isError: 'true' }],
    ['numeric Codex isError state', { isError: 0 }],
    ['string Claude-style is_error state', { is_error: 'false' }],
    ['numeric Claude-style is_error state', { is_error: 1 }]
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'workspace.identity.read',
        authority: 'authority.notion.provider',
        input: { identity: 'current-user' },
        responseProfile: 'notion.codex.connector.v1',
        response: {
          ...flag,
          structuredContent: { result: directClaudeSelfPayload }
        },
        at: AT,
        mappings: [],
        settings: {}
      }),
      /boolean.*error|error.*boolean|response envelope|invalid host error flag/
    );
  }
  for (const [label, responseProfile] of [
    ['missing profile wrapped Notion payload', undefined],
    ['null profile wrapped Notion payload', null],
    ['unknown profile wrapped Notion payload', 'notion.unknown.profile.v1']
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'workspace.identity.read',
        authority: 'authority.notion.provider',
        input: { identity: 'current-user' },
        ...(responseProfile === undefined ? {} : { responseProfile }),
        response: {
          structuredContent: { result: directClaudeSelfPayload }
        },
        at: AT,
        mappings: [],
        settings: {}
      }),
      /response profile/
    );
  }
  for (const [label, responseProfile, response] of [
    ['Codex top-level result response', 'notion.codex.connector.v1', {
      result: directClaudeSelfPayload
    }],
    ['Claude structured-result read response', 'notion.claude.plugin.v1', {
      structuredContent: { result: directClaudeSelfPayload }
    }],
    ['Claude content-text read response', 'notion.claude.plugin.v1', {
      content: [{ type: 'text', text: JSON.stringify(directClaudeSelfPayload) }]
    }],
    ['Claude top-level result response', 'notion.claude.plugin.v1', {
      result: directClaudeSelfPayload
    }]
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'workspace.identity.read',
        authority: 'authority.notion.provider',
        input: { identity: 'current-user' },
        responseProfile,
        response,
        at: AT,
        mappings: [],
        settings: {}
      }),
      /response profile|response envelope|structured or JSON text result|exact direct result shape/
    );
  }
  const codexContentTaskCreate = completeMcp({
    capability: 'tasks.records.create',
    authority: 'authority.tasks.instance',
    input: taskCreateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(taskCreateProviderResult) }]
    },
    at: AT,
    mappings: [tasksMapping],
    settings: taskSettings
  });
  assert.deepEqual(
    codexContentTaskCreate,
    codexTaskCreate,
    'The observed exact Codex JSON content branch must normalize writes identically.'
  );
  await expectFailure(
    'Claude structured-result write response',
    () => completeMcp({
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      input: taskCreateInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        structuredContent: { result: taskCreateProviderResult }
      },
      at: AT,
      mappings: [tasksMapping],
      settings: taskSettings
    }),
    /response profile|response envelope|structured or JSON text result|exact direct result shape/
  );
  await expectFailure(
    'Claude content-text write response',
    () => completeMcp({
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      input: taskCreateInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        content: [{ type: 'text', text: JSON.stringify(taskCreateProviderResult) }]
      },
      at: AT,
      mappings: [tasksMapping],
      settings: taskSettings
    }),
    /response profile|response envelope|structured or JSON text result|exact direct result shape/
  );
  for (const [label, responseProfile] of [
    ['Codex profile direct Notion payload', 'notion.codex.connector.v1'],
    ['missing profile direct Notion payload', undefined],
    ['null profile direct Notion payload', null],
    ['unknown profile direct Notion payload', 'notion.unknown.profile.v1']
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'workspace.identity.read',
        authority: 'authority.notion.provider',
        input: { identity: 'current-user' },
        ...(responseProfile === undefined ? {} : { responseProfile }),
        response: directClaudeSelfPayload,
        at: AT,
        mappings: [],
        settings: {}
      }),
      /structured or JSON text result|undeclared response profile|invalid Codex response envelope/
    );
  }
  for (const [label, response] of [
    ['direct Notion payload with extra prose', {
      ...directClaudeSelfPayload,
      message: 'HOSTILE_DIRECT_NOTION_EXTRA_PROSE'
    }],
    ['direct Notion payload with JSON content wrapper', {
      ...directClaudeSelfPayload,
      content: [{
        type: 'text',
        text: JSON.stringify(directClaudeSelfPayload)
      }]
    }],
    ['direct Notion payload with result wrapper', {
      ...directClaudeSelfPayload,
      result: directClaudeSelfPayload
    }],
    ['direct Notion prose object', {
      title: 'Authenticated Notion user',
      text: 'HOSTILE_DIRECT_NOTION_PROSE_ONLY'
    }],
    ['direct Notion payload with unknown metadata', {
      ...directClaudeSelfPayload,
      metadata: { type: 'unknown' }
    }],
    ['direct Notion payload with open metadata', {
      ...directClaudeSelfPayload,
      metadata: { type: 'self', privateProviderMetadata: privateDirectIdentityMarker }
    }],
    ['direct Notion payload with open self object', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        privateProviderIdentity: privateDirectIdentityMarker
      }
    }],
    ['direct Notion payload without current tool access', {
      ...directClaudeSelfPayload,
      self: {
        workspace: directClaudeSelfPayload.self.workspace,
        user: directClaudeSelfPayload.self.user
      }
    }],
    ['direct Notion payload with invalid current tool status', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        current_tool_access: {
          fetch: { status: 'HOSTILE_PRIVATE_TOOL_STATUS' }
        }
      }
    }],
    ['direct Notion payload with open current tool access entry', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        current_tool_access: {
          fetch: {
            status: 'available',
            rawProviderResponse: privateDirectIdentityMarker
          }
        }
      }
    }],
    ['direct Notion payload with unsafe current tool upgrade URL', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        current_tool_access: {
          fetch: {
            status: 'upgrade_required',
            upgrade_url: 'file:///private/provider/path'
          }
        }
      }
    }],
    ['direct Notion payload with malformed HTTPS current tool upgrade URL', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        current_tool_access: {
          fetch: {
            status: 'upgrade_required',
            upgrade_url: 'https://'
          }
        }
      }
    }],
    ['direct Notion payload with credentialed current tool upgrade URL', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        current_tool_access: {
          fetch: {
            status: 'upgrade_required',
            upgrade_url: 'https://private-user:private-password@example.test/upgrade'
          }
        }
      }
    }],
    ['direct Notion payload with open workspace object', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        workspace: {
          ...directClaudeSelfPayload.self.workspace,
          rawProviderResponse: privateDirectIdentityMarker
        }
      }
    }],
    ['direct Notion payload with open user object', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        user: {
          ...directClaudeSelfPayload.self.user,
          rawProviderResponse: privateDirectIdentityMarker
        }
      }
    }],
    ['direct Notion payload without workspace identity', {
      ...directClaudeSelfPayload,
      self: { user: directClaudeSelfPayload.self.user }
    }],
    ['direct Notion payload without user identity', {
      ...directClaudeSelfPayload,
      self: { workspace: directClaudeSelfPayload.self.workspace }
    }],
    ['direct Notion payload with empty workspace identity', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        workspace: { id: '' }
      }
    }],
    ['direct Notion payload with non-string user identity', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        user: { id: 42 }
      }
    }],
    ['direct Notion payload with non-string optional workspace name', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        workspace: {
          id: 'workspace.direct-selftest',
          name: 42
        }
      }
    }],
    ['direct Notion payload with non-string optional user email', {
      ...directClaudeSelfPayload,
      self: {
        ...directClaudeSelfPayload.self,
        user: {
          id: 'user.direct-selftest',
          email: 42
        }
      }
    }]
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'workspace.identity.read',
        authority: 'authority.notion.provider',
        input: { identity: 'current-user' },
        responseProfile: 'notion.claude.plugin.v1',
        response,
        at: AT,
        mappings: [],
        settings: {}
      }),
      /structured or JSON text result|hybrid direct and wrapped response|invalid direct Claude result|exact direct result shape/
    );
  }
  for (const [label, capability, input, response] of [
    ['direct Claude Notion create without observed properties',
      'tasks.records.create',
      taskCreateInput,
      {
        pages: [{
          id: 'dddddddddddddddddddddddddddddddd',
          url: 'https://www.notion.so/dddddddddddddddddddddddddddddddd'
        }]
      }],
    ['direct Claude Notion create with an open page result',
      'tasks.records.create',
      taskCreateInput,
      {
        pages: [{
          ...taskCreateProviderResult.pages[0],
          rawProviderResponse: 'HOSTILE_DIRECT_NOTION_CREATE_SENTINEL'
        }]
      }],
    ['direct Claude Notion create with multiple pages',
      'tasks.records.create',
      taskCreateInput,
      {
        pages: [
          taskCreateProviderResult.pages[0],
          {
            id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            properties: {},
            url: 'https://www.notion.so/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
          }
        ]
      }],
    ['direct Claude Notion update with an open result',
      'tasks.records.update',
      taskUpdateInput,
      {
        page_id: 'dddddddddddddddddddddddddddddddd',
        rawProviderResponse: 'HOSTILE_DIRECT_NOTION_UPDATE_SENTINEL'
      }],
    ['queued Claude Notion asynchronous task',
      'tasks.records.create',
      taskCreateInput,
      {
        created_time: AT,
        id: 'queued-task-selftest',
        object: 'async_task',
        operation: 'create_pages',
        poll_after_seconds: 1,
        request_id: 'request.selftest',
        status: 'queued',
        status_url: 'https://api.notion.com/v1/async-tasks/queued-task-selftest'
      }]
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability,
        authority: 'authority.tasks.instance',
        input,
        responseProfile: 'notion.claude.plugin.v1',
        response,
        at: AT,
        mappings: [tasksMapping],
        settings: taskSettings
      }),
      /response envelope|exact direct result shape|invalid direct Claude result|queued/
    );
  }
  await expectFailure(
    'Codex direct Notion create response',
    () => completeMcp({
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      input: taskCreateInput,
      responseProfile: 'notion.codex.connector.v1',
      response: taskCreateProviderResult,
      at: AT,
      mappings: [tasksMapping],
      settings: taskSettings
    }),
    /Codex response envelope|governed result representation/
  );
  const privateNotionErrorMarker = 'HOSTILE_PRIVATE_NOTION_ERROR_PROSE';
  let sanitizedNotionError = null;
  try {
    completeMcp({
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      input: taskCreateInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        is_error: true,
        message: privateNotionErrorMarker
      },
      at: AT,
      mappings: [tasksMapping],
      settings: taskSettings
    });
  } catch (error) {
    sanitizedNotionError = error;
  }
  if (!sanitizedNotionError
    || !/returned an error result/.test(sanitizedNotionError.message)
    || sanitizedNotionError.message.includes(privateNotionErrorMarker)) {
    throw new Error('Claude-style Notion error envelopes were not sanitized before normalization.');
  }
  await expectFailure(
    'immutable channel MCP update',
    () => prepareMcp({
      capability: 'communications.records.update',
      input: {
        recordType: 'channel',
        id: 'https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        expectedVersion: '1',
        patch: {
          conversationIdentityFingerprint:
            'sha256:256f5a4abc251f35838c5e60c0bca9f92bfe3e4e4690bea826ceed901001a9c0'
        }
      },
      settings: {
        'integration.notion': {
          targets: { channels: 'collection://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
        }
      },
      mappings: [communicationsMapping]
    }),
    /cannot use field outside its declared write scope: channel\.conversationIdentityFingerprint/
  );
  const readInput = { recordTypes: ['feature'], filters: { status: 'Planned' }, limit: 1 };
  const readRequest = prepareMcp({
    capability: 'product.records.read',
    input: readInput,
    settings,
    mappings: [mapping]
  });
  const createInput = {
    recordType: 'feature',
    deduplicationKey: 'feature-new',
    fields: { title: 'New feature', status: 'Planned' },
    body: '## Problem\nContained fixture only.'
  };
  const createRequest = prepareMcp({
    capability: 'product.records.create',
    input: createInput,
    settings,
    mappings: [mapping]
  });
  const updateInput = {
    recordType: 'feature',
    id: 'https://www.notion.so/Feature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    expectedVersion: '1',
    patch: { status: 'Defined' }
  };
  const updateRequest = prepareMcp({
    capability: 'product.records.update',
    input: updateInput,
    settings,
    mappings: [mapping]
  });
  const productReadProviderResult = {
    results: [{
      __soterType: 'feature',
      __soterId: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      __soterFields: JSON.stringify({ title: 'Existing feature', status: 'Planned' })
    }],
    has_more: false,
    data_source_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    next_cursor: null
  };
  const normalizedRead = completeMcp({
    capability: 'product.records.read',
    authority: AUTHORITY,
    input: readInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: productReadProviderResult
      }
    },
    at: AT,
    mappings: [mapping],
    settings
  });
  const directClaudeRead = completeMcp({
    capability: 'product.records.read',
    authority: AUTHORITY,
    input: readInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: productReadProviderResult,
    at: AT,
    mappings: [mapping],
    settings
  });
  assert.deepEqual(
    directClaudeRead,
    normalizedRead,
    'Direct Claude Notion query data must normalize identically to the governed wrapper.'
  );
  await expectFailure(
    'direct Claude Notion query with an undeclared top-level field',
    () => completeMcp({
      capability: 'product.records.read',
      authority: AUTHORITY,
      input: readInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        ...productReadProviderResult,
        rawProviderResponse: 'HOSTILE_DIRECT_NOTION_QUERY_SENTINEL'
      },
      at: AT,
      mappings: [mapping],
      settings
    }),
    /structured or JSON text result|invalid direct Claude result/
  );
  const { next_cursor: _omittedQueryCursor, ...queryWithoutCursor }
    = productReadProviderResult;
  const directClaudeReadWithoutCursor = completeMcp({
    capability: 'product.records.read',
    authority: AUTHORITY,
    input: readInput,
    responseProfile: 'notion.claude.plugin.v1',
    response: queryWithoutCursor,
    at: AT,
    mappings: [mapping],
    settings
  });
  assert.deepEqual(
    directClaudeReadWithoutCursor,
    directClaudeRead,
    'A completed direct Claude query may omit its null cursor exactly as observed live.'
  );
  for (const [label, response] of [
    ['direct Claude Notion query without a data-source identity', {
      results: productReadProviderResult.results,
      has_more: false,
      next_cursor: null
    }],
    ['direct Claude Notion query with duplicate data-source identities', {
      ...productReadProviderResult,
      data_source_ids: [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      ]
    }],
    ['direct Claude Notion query with an open row', {
      ...productReadProviderResult,
      results: [{
        ...productReadProviderResult.results[0],
        rawProviderResponse: 'HOSTILE_DIRECT_NOTION_QUERY_ROW_SENTINEL'
      }]
    }],
    ['direct Claude Notion query with a non-string data-source identity', {
      ...productReadProviderResult,
      data_source_ids: [42]
    }],
    ['direct Claude Notion completed query with a non-null cursor', {
      ...productReadProviderResult,
      next_cursor: 'unexpected-cursor'
    }],
    ['direct Claude Notion incomplete query with a null cursor', {
      ...productReadProviderResult,
      has_more: true,
      next_cursor: null
    }],
    ['direct Claude Notion incomplete query with an empty cursor', {
      ...productReadProviderResult,
      has_more: true,
      next_cursor: ''
    }],
    ['direct Claude Notion query with non-boolean completeness', {
      ...productReadProviderResult,
      has_more: 'false'
    }]
  ]) {
    await expectFailure(
      label,
      () => completeMcp({
        capability: 'product.records.read',
        authority: AUTHORITY,
        input: readInput,
        responseProfile: 'notion.claude.plugin.v1',
        response,
        at: AT,
        mappings: [mapping],
        settings
      }),
      /structured or JSON text result|invalid direct Claude result/
    );
  }
  await expectFailure(
    'direct Claude Notion query from a substituted data source',
    () => completeMcp({
      capability: 'product.records.read',
      authority: AUTHORITY,
      input: readInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        ...productReadProviderResult,
        data_source_ids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
      },
      at: AT,
      mappings: [mapping],
      settings
    }),
    /outside the exact configured data source/
  );
  await expectFailure(
    'wrapped Codex Notion query from a substituted data source',
    () => completeMcp({
      capability: 'product.records.read',
      authority: AUTHORITY,
      input: readInput,
      responseProfile: 'notion.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            ...productReadProviderResult,
            data_source_ids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
          }
        }
      },
      at: AT,
      mappings: [mapping],
      settings
    }),
    /outside the exact configured data source/
  );
  await expectFailure(
    'direct Claude Notion incomplete query with an exact cursor',
    () => completeMcp({
      capability: 'product.records.read',
      authority: AUTHORITY,
      input: readInput,
      responseProfile: 'notion.claude.plugin.v1',
      response: {
        ...productReadProviderResult,
        has_more: true,
        next_cursor: 'exact-next-cursor'
      },
      at: AT,
      mappings: [mapping],
      settings
    }),
    /pagination is incomplete/
  );
  const exactRequestedFeatureId
    = 'https://www.notion.so/Requested-feature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?pvs=4';
  const exactCurrentAppFeatureId
    = 'https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const exactIdentityReadInput = {
    recordTypes: ['feature'],
    ids: [exactRequestedFeatureId],
    limit: 1
  };
  const exactIdentityReadRequest = prepareMcp({
    capability: 'product.records.read',
    input: exactIdentityReadInput,
    settings,
    mappings: [mapping]
  });
  assert.deepEqual(
    exactIdentityReadRequest.arguments.data.params,
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    'Notion exact record reads must query by the normalized provider page identity.'
  );
  assert.equal(
    JSON.stringify(exactIdentityReadRequest).includes(exactRequestedFeatureId),
    false,
    'Notion exact record reads must not send a copied query-bearing page URL into SQL equality.'
  );
  const exactCurrentAppIdentityReadRequest = prepareMcp({
    capability: 'product.records.read',
    input: {
      recordTypes: ['feature'],
      ids: [exactCurrentAppFeatureId],
      limit: 1
    },
    settings,
    mappings: [mapping]
  });
  assert.deepEqual(
    exactCurrentAppIdentityReadRequest.arguments.data.params,
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    'Current app.notion.com /p/ page identities must use the same exact normalized provider identity.'
  );
  for (const exactAppIdentity of [
    'https://app.notion.com/p/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'https://app.notion.com/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ]) {
    assert.deepEqual(
      prepareMcp({
        capability: 'product.records.read',
        input: { recordTypes: ['feature'], ids: [exactAppIdentity], limit: 1 },
        settings,
        mappings: [mapping]
      }).arguments.data.params,
      ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      'Current app.notion.com UUID spellings must normalize to one exact provider identity.'
    );
  }
  const exactIdentityRead = completeMcp({
    capability: 'product.records.read',
    authority: AUTHORITY,
    input: exactIdentityReadInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'feature',
            __soterId: 'https://www.notion.so/Provider-slug-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            __soterFields: JSON.stringify({ title: 'Exact feature', status: 'Planned' })
          }],
          has_more: false
        }
      }
    },
    at: AT,
    mappings: [mapping],
    settings
  });
  const exactIdentityResult = (ids, returnedIds) => completeMcp({
    capability: 'product.records.read',
    authority: AUTHORITY,
    input: { recordTypes: ['feature'], ids, limit: Math.max(1, returnedIds.length) },
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          results: returnedIds.map((id) => ({
            __soterType: 'feature',
            __soterId: id,
            __soterFields: JSON.stringify({ title: 'Exact feature', status: 'Planned' })
          })),
          has_more: false
        }
      }
    },
    at: AT,
    mappings: [mapping],
    settings
  });
  assert.equal(
    exactIdentityResult(
      [exactCurrentAppFeatureId],
      ['https://app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
    ).records[0].id,
    'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'Fetched and SQL-projected page aliases must normalize to one portable canonical identity.'
  );
  assert.deepEqual(
    exactIdentityRead.records[0].identityBinding,
    {
      state: 'exact-request',
      requestedIdFingerprint: fingerprintJson(exactRequestedFeatureId)
    },
    'Exact record reads must bind the canonical record to the selected raw operator identity.'
  );
  assert.deepEqual(
    normalizedRead.records[0].identityBinding,
    { state: 'observed', requestedIdFingerprint: null },
    'Filter-based record reads must remain observations rather than exact-request bindings.'
  );
  const observedSameRecord = completeMcp({
    capability: 'product.records.read',
    authority: AUTHORITY,
    input: readInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'feature',
            __soterId: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            __soterFields: JSON.stringify({ title: 'Exact feature', status: 'Planned' })
          }],
          has_more: false
        }
      }
    },
    at: AT,
    mappings: [mapping],
    settings
  });
  const exactAliasSameRecord = exactIdentityResult(
    [exactCurrentAppFeatureId],
    ['https://app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
  );
  assert.equal(
    observedSameRecord.records[0].version,
    exactIdentityRead.records[0].version,
    'Request binding metadata must not change one canonical record version.'
  );
  assert.equal(
    exactAliasSameRecord.records[0].version,
    exactIdentityRead.records[0].version,
    'Equivalent exact Notion aliases must not change one canonical record version.'
  );
  for (const invalidAppIdentity of [
    'https://app.notion.com/x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://app.notion.com/p/slug-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra',
    'https://app.notion.com/p%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://app.notion.com/x/../p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https:app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'ftp://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://app.notion.com:444/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://user@app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#private',
    'https://evil.app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '/private/user/secrets.json',
    'ftp://host/private/raw',
    ' https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '
  ]) {
    await expectFailure(
      'malformed current app page identity',
      () => exactIdentityResult([invalidAppIdentity], []),
      /require exact Notion page URL or UUID identities/
    );
  }
  await expectFailure(
    'normalized duplicate requested read identities',
    () => exactIdentityResult([
      exactRequestedFeatureId,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    ], []),
    /duplicate normalized requested identities/
  );
  await expectFailure(
    'substituted exact read identity',
    () => exactIdentityResult(
      [exactRequestedFeatureId],
      ['https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
    ),
    /substituted exact requested identity/
  );
  await expectFailure(
    'normalized duplicate returned read identities',
    () => exactIdentityResult(
      [exactRequestedFeatureId],
      [
        'https://www.notion.so/First-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'https://www.notion.so/Second-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      ]
    ),
    /duplicate records or a substituted exact requested identity/
  );
  const portableSuffixId = 'portable-policy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await expectFailure(
    'portable suffix provider identity',
    () => exactIdentityResult([portableSuffixId], []),
    /require exact Notion page URL or UUID identities/
  );
  await expectFailure(
    'arbitrary path provider identity',
    () => exactIdentityResult(['/private/secret/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], []),
    /require exact Notion page URL or UUID identities/
  );
  await expectFailure(
    'returned portable provider identity',
    () => completeMcp({
      capability: 'product.records.read',
      authority: AUTHORITY,
      input: readInput,
      responseProfile: 'notion.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'feature',
              __soterId: '/private/user/secrets.json',
              __soterFields: JSON.stringify({ title: 'Existing feature', status: 'Planned' })
            }],
            has_more: false
          }
        }
      },
      at: AT,
      mappings: [mapping],
      settings
    }),
    /without an exact Notion page identity/
  );
  const privateWriteEnvelopeMarker = 'PRIVATE_NOTION_WRITE_ENVELOPE_SENTINEL';
  const normalizedCreate = completeMcp({
    capability: 'product.records.create',
    authority: AUTHORITY,
    input: createInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          pages: [{
            id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            url: 'https://www.notion.so/Feature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }],
          rawProviderResponse: privateWriteEnvelopeMarker
        }
      }
    },
    at: AT,
    mappings: [mapping],
    settings
  });
  const normalizedUpdate = completeMcp({
    capability: 'product.records.update',
    authority: AUTHORITY,
    input: updateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          url: 'https://www.notion.so/Feature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          rawProviderResponse: privateWriteEnvelopeMarker
        }
      }
    },
    at: AT,
    mappings: [mapping],
    settings
  });
  const productCreateOutput = readJson(path.join(
    root,
    'soter/capabilities/product.records.create.json'
  )).outputSchema;
  if (validateJsonSchema(normalizedCreate, productCreateOutput).length) {
    throw new Error('Closed Product create output rejected the actual normalized connected result.');
  }
  const completeCreate = (result) => completeMcp({
    capability: 'product.records.create',
    authority: AUTHORITY,
    input: createInput,
    responseProfile: 'notion.codex.connector.v1',
    response: { structuredContent: { result } },
    at: AT,
    mappings: [mapping],
    settings
  });
  const completeUpdate = (result) => completeMcp({
    capability: 'product.records.update',
    authority: AUTHORITY,
    input: updateInput,
    responseProfile: 'notion.codex.connector.v1',
    response: { structuredContent: { result } },
    at: AT,
    mappings: [mapping],
    settings
  });
  await expectFailure(
    'zero returned create pages',
    () => completeCreate({ pages: [] }),
    /must return exactly one created page/
  );
  await expectFailure(
    'non-object returned create result',
    () => completeCreate([]),
    /must be an object/
  );
  await expectFailure(
    'multiple returned create pages',
    () => completeCreate({
      pages: [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      ]
    }),
    /must return exactly one created page/
  );
  await expectFailure(
    'unusable returned create identity',
    () => completeCreate({ pages: [{ id: 'not-a-page-identity' }] }),
    /page URL or UUID record id/
  );
  await expectFailure(
    'conflicting returned create identities',
    () => completeCreate({
      pages: [{
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        url: 'https://www.notion.so/Feature-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      }]
    }),
    /conflicting provider page identities/
  );
  await expectFailure(
    'missing returned update identity',
    () => completeUpdate({}),
    /omitted its provider page identity/
  );
  await expectFailure(
    'wrong returned update identity',
    () => completeUpdate({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    /outside the exact requested identity/
  );
  await expectFailure(
    'conflicting returned update identities',
    () => completeUpdate({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      url: 'https://www.notion.so/Feature-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    }),
    /conflicting provider page identities/
  );
  const probe = prepareProbePlanMcp({
    plan: {
      capabilities: ['product.records.read'],
      authorities: [AUTHORITY]
    },
    settings,
    mappings: [mapping]
  });
  const privateIdentityMarker = 'PRIVATE_NOTION_IDENTITY_SENTINEL';
  const identityStep = {
    ...probe.steps[0],
    scopeFingerprint: fingerprintJson(probe.steps[0].scope)
  };
  const identityObservation = completeProbePlanStepMcp({
    step: identityStep,
    responseProfile: 'notion.codex.connector.v1',
    response: {
      structuredContent: {
        result: {
          metadata: { type: 'self' },
          self: {
            workspace: { id: 'workspace.selftest', name: privateIdentityMarker },
            user: {
              id: 'user://' + taskProviderPersonUuidUpper,
              name: privateIdentityMarker
            }
          }
        }
      }
    },
    plan: {
      capabilities: ['product.records.read'],
      authorities: [AUTHORITY]
    },
    mappings: [mapping],
    at: AT
  });
  const directClaudeIdentityObservation = completeProbePlanStepMcp({
    step: identityStep,
    responseProfile: 'notion.claude.plugin.v1',
    response: directClaudeSelfPayload,
    plan: {
      capabilities: ['product.records.read'],
      authorities: [AUTHORITY]
    },
    mappings: [mapping],
    at: AT
  });
  await expectFailure(
    'Codex probe identity with empty exact subjects',
    () => completeProbePlanStepMcp({
      step: identityStep,
      responseProfile: 'notion.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            metadata: { type: 'self' },
            self: {
              workspace: { id: '' },
              user: { id: '' }
            },
            rawProviderResponse: 'HOSTILE_EMPTY_NOTION_IDENTITY_SENTINEL'
          }
        }
      },
      plan: {
        capabilities: ['product.records.read'],
        authorities: [AUTHORITY]
      },
      mappings: [mapping],
      at: AT
    }),
    /did not return an authenticated workspace and user identity/
  );
  await expectFailure(
    'probe identity with arbitrary user URI payload',
    () => completeProbePlanStepMcp({
      step: identityStep,
      responseProfile: 'notion.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            metadata: { type: 'self' },
            self: {
              workspace: { id: 'workspace.selftest' },
              user: { id: 'user://provider-person-selftest' }
            }
          }
        }
      },
      plan: {
        capabilities: ['product.records.read'],
        authorities: [AUTHORITY]
      },
      mappings: [mapping],
      at: AT
    }),
    /provider person identit|user:\/\/ UUID identity/
  );
  assert.deepEqual(
    directClaudeIdentityObservation,
    identityObservation,
    'Direct Claude Notion self data must produce the same minimized probe observation.'
  );
  for (const [label, responseProfile] of [
    ['missing', undefined],
    ['null', null],
    ['unknown', 'notion.unknown.profile.v1']
  ]) {
    for (const [shape, response] of [
      ['wrapped', { structuredContent: { result: directClaudeSelfPayload } }],
      ['direct', directClaudeSelfPayload]
    ]) {
      await expectFailure(
        label + ' profile ' + shape + ' Notion probe response',
        () => completeProbePlanStepMcp({
          step: identityStep,
          ...(responseProfile === undefined ? {} : { responseProfile }),
          response,
          plan: {
            capabilities: ['product.records.read'],
            authorities: [AUTHORITY]
          },
          mappings: [mapping],
          at: AT
        }),
        /response profile/
      );
    }
  }
  const productReadProbeStep = probe.steps.find((step) => {
    return step.kind === 'read' && step.scope?.capability === 'product.records.read';
  });
  if (!productReadProbeStep) {
    throw new Error('Notion provider probe omitted its exact Product read step.');
  }
  const wrappedProductReadProbeObservation = completeProbePlanStepMcp({
    step: productReadProbeStep,
    responseProfile: 'notion.codex.connector.v1',
    response: { structuredContent: { result: productReadProviderResult } },
    plan: {
      capabilities: ['product.records.read'],
      authorities: [AUTHORITY]
    },
    settings,
    mappings: [mapping],
    at: AT
  });
  const directClaudeProductReadProbeObservation = completeProbePlanStepMcp({
    step: productReadProbeStep,
    responseProfile: 'notion.claude.plugin.v1',
    response: productReadProviderResult,
    plan: {
      capabilities: ['product.records.read'],
      authorities: [AUTHORITY]
    },
    settings,
    mappings: [mapping],
    at: AT
  });
  assert.deepEqual(
    directClaudeProductReadProbeObservation,
    wrappedProductReadProbeObservation,
    'Direct Claude Notion query data must produce the same minimized read probe observation.'
  );
  const crmProbeWithoutOptionalChannels = prepareProbePlanMcp({
    plan: {
      capabilities: ['crm.records.read'],
      authorities: ['authority.crm.instance']
    },
    settings: {
      'integration.notion': {
        targets: { organizations: 'collection://cccccccccccccccccccccccccccccccc' }
      }
    },
    mappings: [crmMapping]
  });
  const communicationsProbe = prepareProbePlanMcp({
    plan: {
      capabilities: ['communications.records.read'],
      authorities: ['authority.communications.instance']
    },
    settings: {
      'integration.notion': {
        targets: { channels: 'collection://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      }
    },
    mappings: [communicationsMapping]
  });
  const taskProbeSettings = {
    'integration.notion': {
      targets: {
        policies: 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        projects: 'collection://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        tasks: 'collection://cccccccccccccccccccccccccccccccc'
      },
      optionMappings: structuredClone(
        taskSettings['integration.notion'].optionMappings
      )
    }
  };
  const taskScopedProbe = prepareProbePlanMcp({
    plan: {
      capabilities: [
        'projects.records.read',
        'tasks.records.create',
        'tasks.records.read'
      ],
      authorities: [
        'authority.projects.instance',
        'authority.tasks.definition',
        'authority.tasks.instance'
      ]
    },
    settings: taskProbeSettings,
    mappings: [projectsMapping, tasksMapping],
    operatorRecordRequirements: [
      {
        capability: 'tasks.records.read',
        recordTypes: ['task-work-policy', 'task']
      },
      {
        capability: 'projects.records.read',
        recordTypes: ['project']
      },
      {
        capability: 'tasks.records.create',
        recordTypes: ['task']
      }
    ]
  });
  const conversationReviewScopedProbe = prepareProbePlanMcp({
    plan: {
      capabilities: ['communications.records.read'],
      authorities: ['authority.communications.definition']
    },
    settings: {
      'integration.notion': {
        targets: {
          policies: 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          channels: 'collection://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        }
      }
    },
    mappings: [communicationsMapping],
    operatorRecordRequirements: [{
      capability: 'communications.records.read',
      recordTypes: ['conversation-review-policy']
    }]
  });
  const broadCommunicationsProbe = prepareProbePlanMcp({
    plan: {
      capabilities: ['communications.records.read'],
      authorities: ['authority.communications.instance']
    },
    settings: {
      'integration.notion': {
        targets: {
          policies: 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          channels: 'collection://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        }
      }
    },
    mappings: [communicationsMapping]
  });
  await expectFailure(
    'missing operator record mapping',
    () => prepareProbePlanMcp({
      plan: {
        capabilities: ['communications.records.read'],
        authorities: ['authority.communications.definition']
      },
      settings: {
        'integration.notion': {
          targets: { policies: 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
        }
      },
      mappings: [communicationsMapping],
      operatorRecordRequirements: [{
        capability: 'communications.records.read',
        recordTypes: ['missing-policy']
      }]
    }),
    /must resolve one exact mapping.*found 0/
  );
  const duplicateCommunicationsMapping = structuredClone(communicationsMapping);
  duplicateCommunicationsMapping.id
    = 'mapping.integration.notion.communications-records-duplicate';
  await expectFailure(
    'ambiguous operator record mapping',
    () => prepareProbePlanMcp({
      plan: {
        capabilities: ['communications.records.read'],
        authorities: ['authority.communications.definition']
      },
      settings: {
        'integration.notion': {
          targets: { policies: 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
        }
      },
      mappings: [communicationsMapping, duplicateCommunicationsMapping],
      operatorRecordRequirements: [{
        capability: 'communications.records.read',
        recordTypes: ['conversation-review-policy']
      }]
    }),
    /must resolve one exact mapping.*found 2/
  );
  const taskScopedRecordTypes = new Set(taskScopedProbe.steps.flatMap((step) => {
    return step.scope?.recordType ? [step.scope.recordType] : [];
  }));
  const conversationReviewRecordTypes = new Set(
    conversationReviewScopedProbe.steps.flatMap((step) => {
      return step.scope?.recordType ? [step.scope.recordType] : [];
    })
  );
  const broadCommunicationsRecordTypes = new Set(
    broadCommunicationsProbe.steps.flatMap((step) => {
      return step.scope?.recordType ? [step.scope.recordType] : [];
    })
  );
  const taskSchemaProbeStep = taskScopedProbe.steps.find((step) => {
    return step.kind === 'schema' && step.scope?.recordType === 'task';
  });
  const taskSchemaProbeResponse = {
    structuredContent: {
      result: {
        metadata: { type: 'data_source' },
        text: '<data-source url="{{collection://cccccccccccccccccccccccccccccccc}}">'
          + '<data-source-state>'
          + JSON.stringify({
            schema: {
              Name: { name: 'Name', type: 'title' },
              Status: {
                name: 'Status',
                type: 'status',
                groups: {
                  to_do: [{ name: privateTaskProviderStatus }],
                  in_progress: [],
                  complete: []
                }
              },
              Context: {
                name: 'Context',
                type: 'select',
                options: [{ name: privateTaskProviderContext }]
              },
              Project: { name: 'Project', type: 'relation' },
              'Assigned To': { name: 'Assigned To', type: 'person' },
              'Next Action': { name: 'Next Action', type: 'date' },
              'Source Meetings': { name: 'Source Meetings', type: 'relation' },
              Grounding: { name: 'Grounding', type: 'text' },
              'Summary Fingerprints': {
                name: 'Summary Fingerprints',
                type: 'text'
              }
            }
          })
          + '</data-source-state></data-source>'
      }
    }
  };
  const taskSchemaProbeObservation = completeProbePlanStepMcp({
    step: taskSchemaProbeStep,
    responseProfile: 'notion.codex.connector.v1',
    response: taskSchemaProbeResponse,
    plan: {
      capabilities: [
        'projects.records.read',
        'tasks.records.create',
        'tasks.records.read'
      ],
      authorities: [
        'authority.projects.instance',
        'authority.tasks.definition',
        'authority.tasks.instance'
      ]
    },
    settings: taskProbeSettings,
    mappings: [projectsMapping, tasksMapping],
    at: AT
  });
  const directClaudeTaskSchemaProbeObservation = completeProbePlanStepMcp({
    step: taskSchemaProbeStep,
    responseProfile: 'notion.claude.plugin.v1',
    response: taskSchemaProbeResponse.structuredContent.result,
    plan: {
      capabilities: [
        'projects.records.read',
        'tasks.records.create',
        'tasks.records.read'
      ],
      authorities: [
        'authority.projects.instance',
        'authority.tasks.definition',
        'authority.tasks.instance'
      ]
    },
    settings: taskProbeSettings,
    mappings: [projectsMapping, tasksMapping],
    at: AT
  });
  assert.deepEqual(
    directClaudeTaskSchemaProbeObservation,
    taskSchemaProbeObservation,
    'Direct Claude Notion data-source state must produce the same minimized schema observation.'
  );
  const missingTaskProbeOptionSettings = structuredClone(taskProbeSettings);
  missingTaskProbeOptionSettings['integration.notion'].optionMappings
    = missingTaskProbeOptionSettings['integration.notion'].optionMappings.slice(1);
  await expectFailure(
    'schema probe missing exact task option mapping',
    () => completeProbePlanStepMcp({
      step: taskSchemaProbeStep,
      responseProfile: 'notion.codex.connector.v1',
      response: taskSchemaProbeResponse,
      plan: {
        capabilities: ['tasks.records.create', 'tasks.records.read'],
        authorities: ['authority.tasks.instance']
      },
      settings: missingTaskProbeOptionSettings,
      mappings: [tasksMapping],
      at: AT
    }),
    /does not map one required portable choice field/
  );
  const staleTaskProbeResponse = structuredClone(taskSchemaProbeResponse);
  staleTaskProbeResponse.structuredContent.result.text
    = staleTaskProbeResponse.structuredContent.result.text.replace(
      privateTaskProviderStatus,
      'PRIVATE_STALE_PROVIDER_TASK_STATUS_SENTINEL'
    );
  await expectFailure(
    'schema probe stale provider option set',
    () => completeProbePlanStepMcp({
      step: taskSchemaProbeStep,
      responseProfile: 'notion.codex.connector.v1',
      response: staleTaskProbeResponse,
      plan: {
        capabilities: ['tasks.records.create', 'tasks.records.read'],
        authorities: ['authority.tasks.instance']
      },
      settings: taskProbeSettings,
      mappings: [tasksMapping],
      at: AT
    }),
    /does not cover the exact current provider choice set/
  );
  if (readRequest.tool !== 'query_data_sources'
    || createRequest.tool !== 'create_pages'
    || updateRequest.tool !== 'update_page'
    || normalizedRead.records[0]?.type !== 'feature'
    || exactIdentityRead.records[0]?.id
      !== 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    || normalizedRead.provenance.mapping !== mapping.id
    || normalizedCreate.created !== true
    || normalizedCreate.record.id
      !== 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    || normalizedUpdate.record.id
      !== 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    || JSON.stringify({ exactIdentityRead, normalizedCreate, normalizedUpdate })
      .includes('Provider-slug')
    || JSON.stringify({ exactIdentityRead, normalizedCreate, normalizedUpdate })
      .includes('/Feature-')
    || JSON.stringify(normalizedUpdate.changedFields) !== JSON.stringify(['status'])
    || JSON.stringify({ normalizedCreate, normalizedUpdate }).includes(privateWriteEnvelopeMarker)
    || !identityObservation.identityAuthenticated
    || JSON.stringify(identityObservation).includes(privateIdentityMarker)
    || probe.steps.filter((step) => step.scope?.mappingId === mapping.id).length !== 2
    || crmProbeWithoutOptionalChannels.steps.some((step) => {
      return step.scope?.recordType === 'channel';
    })
    || crmProbeWithoutOptionalChannels.steps.filter((step) => {
      return step.scope?.recordType === 'organization';
    }).length !== 2
    || communicationsProbe.steps.filter((step) => {
      return step.scope?.recordType === 'channel';
    }).length !== 2
    || JSON.stringify([...taskScopedRecordTypes].sort()) !== JSON.stringify([
      'project',
      'task',
      'task-work-policy'
    ])
    || JSON.stringify([...conversationReviewRecordTypes]) !== JSON.stringify([
      'conversation-review-policy'
    ])
    || JSON.stringify([...broadCommunicationsRecordTypes].sort()) !== JSON.stringify([
      'channel',
      'channel-ingestion-policy',
      'conversation-review-policy'
    ])
    || taskSchemaProbeObservation.schemaCompatible !== true
    || taskSchemaProbeObservation.choiceFieldCount !== 2
    || taskSchemaProbeObservation.mappedFieldCount !== 9
    || JSON.stringify(taskSchemaProbeObservation).includes(privateTaskProviderStatus)
    || JSON.stringify(taskSchemaProbeObservation).includes(privateTaskProviderContext)) {
    throw new Error('Generic connected Notion translation did not preserve the Product mapping boundary.');
  }

  process.stdout.write(
    'Notion record mapping selftest: canonical v1, Context namespace isolation, field-level write scope, generic fixture operations, connected translation, and probe planning passed.\n'
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  selftestNotionRecordMappings(process.cwd()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
