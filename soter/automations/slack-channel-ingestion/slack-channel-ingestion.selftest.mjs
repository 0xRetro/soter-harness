import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { fingerprintJson, fingerprintPath, readJson, writeJson } from '../../core/lib/canonical-json.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import {
  createReviewOnlyCandidatePreview,
  evaluateReviewOnlyCandidatePreviewVerification
} from '../../core/review-only-candidate-previews.mjs';
import { createReviewOnlyCandidateSelection } from '../../core/review-only-candidate-selections.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import { evaluateSlackChannelConnectedVerification } from './connected.mjs';
import { runContainedSlackChannelIngestionScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T20:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-slack-channel-selftest-'));
  for (const directory of ['soter', '.claude']) {
    if (!fs.existsSync(path.join(root, directory))) continue;
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

export async function selftestSlackChannelIngestion(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const recordsPath = path.join(
      temporaryRoot,
      'soter/fixtures/providers/notion/workspace-records.json'
    );
    const recordsFixture = readJson(recordsPath);
    const existingChannel = recordsFixture.data.records.find((record) => {
      return record.type === 'channel'
        && record.id === 'soter-fixture://communications/channel/existing-spell';
    });
    existingChannel.fields.personUris = null;
    existingChannel.fields.organizationUris = null;
    writeJson(recordsPath, recordsFixture);
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/slack-channel-ingestion.config.json'
    });
    const lockPath = 'soter/fixtures/slack-channel-ingestion/slack-channel-ingestion.lock.json';
    fs.mkdirSync(path.join(temporaryRoot, 'soter', 'fixtures', 'slack-channel-ingestion'), {
      recursive: true
    });
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const scenario = await runContainedSlackChannelIngestionScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      identityScenarioPath: 'soter/scenarios/slack-channel-ingestion/identity-review.scenario.json',
      selectedScenarioPath: 'soter/scenarios/slack-channel-ingestion/selected-enrichment.scenario.json',
      workId: 'work.slack-channel-ingestion.preparation-selftest',
      identityScenarioEvidenceId: 'evidence.slack-channel-ingestion.identity-review.selftest',
      selectedScenarioEvidenceId: 'evidence.slack-channel-ingestion.selected-enrichment.selftest',
      createdAt: AT
    });
    assert.equal(
      scenario.identityAssessment.result,
      'passed',
      JSON.stringify(scenario.identityAssessment, null, 2)
    );
    assert.equal(
      scenario.selectedAssessment.result,
      'passed',
      JSON.stringify(scenario.selectedAssessment, null, 2)
    );
    assert.equal(scenario.identityScenarioEvidence.result, 'passed');
    assert.equal(scenario.selectedScenarioEvidence.result, 'passed');

    const identityWithSelection = await prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.slack-channel-ingestion',
        configurationName: 'slack-channel-ingestion',
        configurationBasis: 'tracked-contained',
        input: {
          phase: 'identity-review',
          workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained',
          selectedConversationIds: ['C001']
        },
        createdAt: '2026-07-21T20:01:00.000Z'
      });
    assert.equal(identityWithSelection.state, 'needs-input');
    assert.equal(
      identityWithSelection.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );
    const selectedWithoutIds = await prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.slack-channel-ingestion',
        configurationName: 'slack-channel-ingestion',
        configurationBasis: 'tracked-contained',
        input: {
          phase: 'selected-enrichment',
          workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained'
        },
        createdAt: '2026-07-21T20:01:30.000Z'
      });
    assert.equal(selectedWithoutIds.state, 'needs-input');
    assert.equal(
      selectedWithoutIds.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );
    const identity = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.slack-channel-ingestion',
      configurationName: 'slack-channel-ingestion',
      configurationBasis: 'tracked-contained',
      input: {
        phase: 'identity-review',
        workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained',
        nameFilter: 'spell-planning'
      },
      createdAt: '2026-07-21T20:02:00.000Z'
    });
    assert.equal(identity.state, 'ready-for-review');
    assert.equal(identity.preview.kind, 'slack-channel-identity-preview');
    assert.equal(identity.preview.collections[0].rows.length, 2);
    assert.equal(identity.preview.proposedChanges.length, 0);
    assert.equal(identity.approval.state, 'not-requested');
    assert.equal(identity.continuationRequest, null);
    assert(!identity.capabilities.steps.some((capability) => {
      return capability.capability === 'communications.participants.read';
    }));
    const identityPrivate = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: identity.id
    });
    assert.equal(identityPrivate.items.length, 2);
    assert(identityPrivate.items.every((item) => item.kind === 'channel-identity'));

    const selected = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.slack-channel-ingestion',
      configurationName: 'slack-channel-ingestion',
      configurationBasis: 'tracked-contained',
      input: {
        phase: 'selected-enrichment',
        workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained',
        selectedConversationIds: ['C001', 'C002']
      },
      createdAt: '2026-07-21T20:03:00.000Z'
    });
    assert.equal(selected.state, 'ready-for-review');
    assert.equal(selected.preview.kind, 'slack-channel-enrichment-preview');
    assert.equal(selected.preview.proposedChanges.length, 2);
    assert.equal(selected.approval.state, 'not-requested');
    assert.equal(selected.continuationRequest, null);
    assert(selected.capabilities.steps.some((capability) => {
      return capability.capability === 'communications.participants.read';
    }));
    const rows = selected.preview.collections[0].rows;
    const proposed = rows.flatMap((row) => row.actions).filter((action) => {
      return action.state === 'proposed';
    });
    assert.deepEqual(proposed.map((action) => action.kind).sort(), [
      'channel-create', 'channel-update'
    ]);
    assert(rows.flatMap((row) => row.actions).some((action) => {
      return action.kind === 'contact-capture-handoff' && action.state === 'handoff';
    }));
    const privateMaterial = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: selected.id
    });
    const proposedItems = privateMaterial.items.filter((item) => {
      return ['channel-create', 'channel-update'].includes(item.kind);
    });
    assert.equal(proposedItems.length, 2);
    assert(proposedItems.every((item) => item.fields.every((field) => {
      return ![
        'providerWorkspaceId',
        'providerConversationId',
        'providerParticipantId',
        'providerIdentityFingerprint',
        'permalink'
      ].includes(field.id);
    })));
    assert(!JSON.stringify(proposedItems).includes(
      'soter-fixture://configuration-template/slack/workspace/contained'
    ));
    assert(!JSON.stringify(proposedItems).includes('C001'));
    assert(!JSON.stringify(proposedItems).includes('C002'));
    assert(proposedItems.every((item) => item.fields.find((field) => {
      return field.id === 'personUris';
    }).reviewValue.every((uri) => uri.startsWith('soter-fixture://crm/person/'))));
    const createAction = proposed.find((action) => action.kind === 'channel-create');
    const updateAction = proposed.find((action) => action.kind === 'channel-update');
    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: selected.id,
      actionIds: [createAction.id],
      createdAt: '2026-07-21T20:03:30.000Z'
    });
    assert.equal(selection.scope.partial, true);
    const preview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: selection.id,
      createdAt: '2026-07-21T20:04:00.000Z'
    });
    assert.equal(preview.state, 'blocked-review-only');
    assert.equal(preview.executable, false);
    assert.equal(preview.operations.length, 1);
    assert.equal(preview.operations[0].capability, 'communications.records.create');
    assert.deepEqual(preview.operations[0].verification.inputBindings, [{
      id: 'binding.slack-channel-ingestion.created-channel-id',
      sourceStage: 'write',
      sourcePath: ['record', 'id'],
      targetPath: ['ids'],
      transform: 'singleton-string-list'
    }]);
    const createdChannelId = 'soter-fixture://communications/channel/created-exact';
    const exactVerificationInput = {
      recordTypes: ['channel'],
      ids: [createdChannelId],
      limit: 2
    };
    assert.equal(evaluateSlackChannelConnectedVerification({
      operation: preview.operations[0],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'channel',
          id: createdChannelId,
          fields: structuredClone(preview.operations[0].input.fields)
        }]
      }
    }).state, 'passed');
    assert.equal(evaluateSlackChannelConnectedVerification({
      operation: preview.operations[0],
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'channel',
          id: 'soter-fixture://communications/channel/concurrent-same-identity',
          fields: structuredClone(preview.operations[0].input.fields)
        }]
      }
    }).state, 'failed');
    const setSemanticOperation = structuredClone(preview.operations[0]);
    const setSemanticFields = {
      ...setSemanticOperation.input.fields,
      personUris: [
        'soter-fixture://crm/person/a',
        'soter-fixture://crm/person/b'
      ],
      organizationUris: [
        'soter-fixture://crm/organization/a',
        'soter-fixture://crm/organization/b'
      ]
    };
    setSemanticOperation.verification.expectation.expectedFingerprint = fingerprintJson({
      fields: setSemanticFields,
      recordIdState: 'write-output-bound'
    });
    assert.equal(evaluateSlackChannelConnectedVerification({
      operation: setSemanticOperation,
      resolvedInput: exactVerificationInput,
      output: {
        records: [{
          type: 'channel',
          id: createdChannelId,
          fields: {
            ...setSemanticFields,
            personUris: [...setSemanticFields.personUris].reverse(),
            organizationUris: [...setSemanticFields.organizationUris].reverse()
          }
        }]
      }
    }).state, 'passed');
    for (const malformedRelation of [
      'soter-fixture://crm/person/not-a-list',
      { id: 'soter-fixture://crm/person/not-a-list' },
      true,
      7,
      ['soter-fixture://crm/person/a', 'soter-fixture://crm/person/a'],
      ['soter-fixture://crm/person/a', 7]
    ]) {
      assert.equal(evaluateSlackChannelConnectedVerification({
        operation: setSemanticOperation,
        resolvedInput: exactVerificationInput,
        output: {
          records: [{
            type: 'channel',
            id: createdChannelId,
            fields: {
              ...setSemanticFields,
              personUris: malformedRelation
            }
          }]
        }
      }).state, 'failed',
      'Malformed non-null relation output must never normalize to an empty or valid set.');
    }
    const updateSelection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: selected.id,
      actionIds: [updateAction.id],
      createdAt: '2026-07-21T20:03:40.000Z'
    });
    const updatePreview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: updateSelection.id,
      createdAt: '2026-07-21T20:04:10.000Z'
    });
    assert.equal(updatePreview.operations[0].capability, 'communications.records.update');
    const updateOperation = updatePreview.operations[0];
    const before = updateOperation.review.before.reviewValue;
    assert.equal(evaluateSlackChannelConnectedVerification({
      operation: updateOperation,
      phase: 'precondition',
      output: {
        records: [{
          type: 'channel',
          id: before.id,
          version: before.version,
          fields: {
            ...before.fields,
            personUris: null,
            organizationUris: null
          }
        }]
      }
    }).state, 'passed',
    'Null provider relations must normalize to the exact empty portable before-state.');
    await assert.rejects(
      () => evaluateReviewOnlyCandidatePreviewVerification({
        root: temporaryRoot,
        candidatePreviewId: updatePreview.id,
        operationId: updateOperation.id,
        output: {
          records: [{
            type: 'channel',
            id: before.id,
            version: '2',
            fields: {
              ...updateOperation.review.after.reviewValue,
              rawProviderResponse: 'HOSTILE_PREPARED_CHANNEL_FIELD_SENTINEL'
            },
            identityBinding: {
              state: 'exact-request',
              requestedIdFingerprint: fingerprintJson(before.id)
            }
          }],
          provenance: {
            provider: 'notion-fixture',
            authority: 'authority.communications.instance',
            mapping: 'mapping.integration.notion.communications-records',
            mappingVersion: '0.1.0',
            sourceKind: 'fixture',
            sourceReferenceFingerprint: 'sha256:' + '1'.repeat(64)
          },
          observedAt: AT
        }
      }),
      (error) => error.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_INVALID'
    );
    assert.equal(preview.privacy.approvalAuthorityIncluded, false);
    assert.equal(preview.privacy.executionAuthorityIncluded, false);

    const slackFixtureFile = path.join(
      temporaryRoot,
      'soter/fixtures/providers/slack/workspace.json'
    );
    const lockFile = path.join(temporaryRoot, lockPath);
    const originalSlackFixture = fs.readFileSync(slackFixtureFile, 'utf8');
    const originalLock = fs.readFileSync(lockFile, 'utf8');
    const providerWithoutPermalink = JSON.parse(originalSlackFixture);
    delete providerWithoutPermalink.data.channels.find((channel) => {
      return channel.id === 'C002';
    }).permalink;
    writeJson(slackFixtureFile, providerWithoutPermalink);
    writeJson(lockFile, resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/slack-channel-ingestion.config.json'
    }));
    const selectedWithoutPermalink = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.slack-channel-ingestion',
      configurationName: 'slack-channel-ingestion',
      configurationBasis: 'tracked-contained',
      input: {
        phase: 'selected-enrichment',
        workspaceId: 'soter-fixture://configuration-template/slack/workspace/contained',
        selectedConversationIds: ['C002']
      },
      createdAt: '2026-07-21T20:05:00.000Z'
    });
    assert.equal(selectedWithoutPermalink.state, 'ready-for-review');
    const noPermalinkMaterial = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: selectedWithoutPermalink.id
    });
    const noPermalinkCreate = noPermalinkMaterial.items.find((item) => {
      return item.kind === 'channel-create';
    });
    assert.equal(noPermalinkCreate.fields.some((field) => field.id === 'permalink'), false);
    const noPermalinkAction = selectedWithoutPermalink.preview.collections[0].rows
      .flatMap((row) => row.actions)
      .find((action) => action.kind === 'channel-create');
    const noPermalinkSelection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: selectedWithoutPermalink.id,
      actionIds: [noPermalinkAction.id],
      createdAt: '2026-07-21T20:05:30.000Z'
    });
    const noPermalinkPreview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: noPermalinkSelection.id,
      createdAt: '2026-07-21T20:06:00.000Z'
    });
    assert.equal(Object.hasOwn(noPermalinkPreview.operations[0].input.fields, 'permalink'), false);
    assert.equal(Object.hasOwn(
      noPermalinkPreview.operations[0].input.fields,
      'providerWorkspaceId'
    ), false);
    assert.equal(Object.hasOwn(
      noPermalinkPreview.operations[0].input.fields,
      'providerConversationId'
    ), false);
    fs.writeFileSync(slackFixtureFile, originalSlackFixture);
    fs.writeFileSync(lockFile, originalLock);

    const sanitized = JSON.stringify({
      identity,
      selected,
      inspection: inspectWorkspace({ root: temporaryRoot })
    });
    for (const privateValue of [
      'soter-fixture://configuration-template/slack/workspace/contained',
      'C001',
      'C002',
      'spell-planning-internal',
      'spell-planning-acme',
      'maya.fixture@example.test',
      'quinn.unmatched@example.test',
      'https://fixture.slack.test/archives/C001'
    ]) {
      assert(!sanitized.includes(privateValue), 'Sanitized projection leaked ' + privateValue + '.');
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
    process.stdout.write('Slack channel-ingestion selftest: complete public/private identity review, explicit selected-member gate, bot exclusion, exact relation matches, fingerprint-only portable directory writes, residue handoffs, partial selection compilation, privacy, and zero live effects passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestSlackChannelIngestion();
}
