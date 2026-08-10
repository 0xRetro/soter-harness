import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error The canonical Kernel distribution module is checked JavaScript without declarations.
import { buildBundle, buildPackRelease } from '../../../kernel/distribution.mjs';
// @ts-expect-error The canonical Core contained-state module is checked JavaScript without declarations.
import { materializeContainedPrivateConfiguration } from '../../../core/contained-private-configurations.mjs';
// @ts-expect-error The canonical JSON helper is checked JavaScript without declarations.
import { fingerprintJson } from '../../../core/lib/canonical-json.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, '../../../..');
const axeSource = fs.readFileSync(path.join(repositoryRoot, 'node_modules/axe-core/axe.min.js'), 'utf8');
const privateMeetingOptionPrefix = 'PRIVATE_PROVIDER_STUDIO_MEETING_OPTION_';

test.setTimeout(90_000);

function meetingOptionMapping(
  mapping: string,
  recordType: string,
  field: string,
  values: string[]
) {
  return {
    mapping,
    recordType,
    field,
    mode: 'exact-bijection',
    entries: values.map((portable) => ({
      portable,
      provider: privateMeetingOptionPrefix
        + field.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
        + '_'
        + portable.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    }))
  };
}

function meetingIntakeOptionMappings() {
  return [
    meetingOptionMapping(
      'mapping.integration.notion.meetings-records',
      'meeting',
      'meetingType',
      ['Review']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.meetings-records',
      'meeting-summary',
      'documentType',
      ['Meeting Summary']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'organizationType',
      ['Foundation']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'tags',
      ['DeFi']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      ['Project']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      ['active']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'status',
      ['To Do']
    ),
    meetingOptionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'context',
      ['Project']
    )
  ];
}

function containedWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-studio-e2e-'));
  fs.cpSync(path.join(repositoryRoot, 'soter'), path.join(root, 'soter'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.studio.json']) {
    fs.copyFileSync(path.join(repositoryRoot, name), path.join(root, name));
  }
  for (const unmanagedHostOutput of [
    'AGENTS.md',
    'CLAUDE.md',
    '.agents',
    '.codex',
    '.claude',
    '.claude-plugin'
  ]) {
    if (fs.existsSync(path.join(root, unmanagedHostOutput))) {
      throw new Error('Contained Studio root adopted unmanaged host output: ' + unmanagedHostOutput);
    }
  }
  return root;
}

function containedHostConsumer() {
  const root = containedWorkspace();
  materializeContainedPrivateConfiguration({
    root,
    configurationName: 'meeting-intake',
    host: 'codex',
    notionOptionMappings: meetingIntakeOptionMappings()
  });
  return root;
}

function workspaceFingerprint(root: string) {
  const values: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (path.relative(root, target).split(path.sep)[0] === '.soter') continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) values.push(path.relative(root, target) + ':' + crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
    }
  };
  visit(root);
  return crypto.createHash('sha256').update(values.join('\n')).digest('hex');
}

function nonPrivateWorkspaceFiles(root: string) {
  const values = new Map<string, { fingerprint: string; mode: string }>();
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (path.relative(root, target).split(path.sep)[0] === '.soter') continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) values.set(path.relative(root, target), {
        fingerprint: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
        mode: (fs.statSync(target).mode & 0o777).toString(8).padStart(4, '0')
      });
    }
  };
  visit(root);
  return values;
}

function containedDistributionArtifacts(root: string) {
  const outputRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-studio-distribution-'));
  const release = buildPackRelease({
    root,
    pack: 'kernel.soter',
    outputDirectory: path.join(outputRoot, 'releases'),
    createdAt: '2026-07-16T12:00:00.000Z'
  });
  const bundle = buildBundle({
    root,
    outputDirectory: path.join(outputRoot, 'bundles'),
    definition: {
      id: 'bundle.studio-contained',
      version: '0.1.0',
      summary: 'Transparent contained bundle used to prove the production Studio inspection boundary.',
      releaseStage: 'experimental',
      createdAt: '2026-07-16T12:01:00.000Z',
      target: { baseContract: '1.0.0', hosts: ['codex'] },
      references: [{
        id: 'bundle-ref.kernel.soter',
        pack: 'kernel.soter',
        selection: {
          kind: 'exact',
          version: release.inspection.release.version,
          capsuleDigest: release.capsuleDigest
        },
        reason: 'Include the exact contained Kernel release in this transparent local inspection.',
        compatibilityLimitations: []
      }],
      limitations: []
    }
  });
  return { outputRoot, releasePath: release.capsulePath, bundlePath: bundle.bundlePath };
}

async function launch(root: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd: repositoryRoot, env: { ...process.env, SOTER_ROOT: root, ELECTRON_DISABLE_SECURITY_WARNINGS: 'false' } });
  const page = await app.firstWindow();
  await page.waitForSelector('.studio-shell');
  return { app, page };
}

async function prepareContainedRun(page: Page, expectedOutcome: Locator) {
  const route = page.url();
  await page.getByRole('button', { name: 'Prepare contained run' }).click({ noWaitAfter: true });
  await expect(expectedOutcome).toBeVisible({ timeout: 45_000 });
  expect(page.url()).toBe(route);
}

test('launches with a sandboxed canonical adapter and performs zero workspace writes while browsing', async () => {
  test.setTimeout(180_000);
  const root = containedWorkspace();
  const before = workspaceFingerprint(root);
  const { app, page } = await launch(root);
  try {
    expect(await app.evaluate(() => process.env.SOTER_ROOT)).toBe(root);
    const minimum = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const size = window.getMinimumSize();
      window.setSize(1040, 680);
      return size;
    });
    expect(minimum).toEqual([1040, 680]);
    const boundary = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      ipcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
      api: Object.keys(window.soterStudio).sort()
    }));
    expect(boundary).toEqual({
      require: 'undefined', process: 'undefined', ipcRenderer: 'undefined',
      api: ['beginConfigurationChangeRequest', 'beginHostRealizationRequest', 'beginPackInstallRequest', 'beginProposalConnectedApproval', 'confirmConfigurationChangeRequest', 'confirmConnectedApproval', 'confirmHostRealizationRequest', 'confirmPackInstallRequest', 'createReviewOnlyCandidatePreview', 'createReviewOnlyCandidateSelection', 'describeConfigurationOnboarding', 'executeConfigurationChange', 'executeHostRealization', 'executePackInstall', 'getAutomationProposal', 'getAutomationProposalMaterial', 'getConnectedApprovalReview', 'getOperatorActivity', 'getPreparedWork', 'getPreparedWorkDerivedReview', 'getPreparedWorkReview', 'getReviewOnlyCandidatePreview', 'getReviewOnlyCandidateSelectionMaterial', 'getWorkspaceSnapshot', 'inspectConfigurationChange', 'inspectHostRealization', 'inspectLocalBundle', 'inspectLocalPackRelease', 'inspectPackInstall', 'onWorkspaceInvalidated', 'prepareAutomationRun', 'prepareConfigurationOnboarding', 'prepareConnectedReconciliation', 'prepareHostRealization', 'preparePackInstall', 'previewConfiguration', 'previewProposalConnectedBatch', 'recoverConfigurationChange', 'recoverHostRealization', 'recoverPackInstall', 'refreshWorkspaceSnapshot', 'startConfigurationChange', 'startConnectedTransaction', 'startHostRealization', 'startPackInstall']
    });
    const productionCsp = await page.evaluate(async () => {
      const response = await fetch(window.location.href);
      return response.headers.get('content-security-policy');
    });
    expect(productionCsp).toContain("connect-src 'self'");
    expect(productionCsp).not.toContain('127.0.0.1');
    expect(productionCsp).not.toContain('ws://');
    const unboundProposalReads = await page.evaluate(async () => {
      const snapshot = await window.soterStudio.getWorkspaceSnapshot();
      const configuration = snapshot.configurations.find((item) => item.name === 'email-triage');
      if (!configuration?.lockFingerprint) throw new Error('Email configuration lock is unavailable.');
      const request = {
        proposalId: 'proposal.email-triage.missing',
        configurationName: configuration.name,
        lockFingerprint: configuration.lockFingerprint
      };
      return Promise.all([
        window.soterStudio.getAutomationProposal(request),
        window.soterStudio.getAutomationProposalMaterial(request)
      ]);
    });
    expect(unboundProposalReads).toEqual([{
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_BINDING_INVALID',
        message: 'The selected review-only proposal is unavailable.'
      }
    }, {
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_BINDING_INVALID',
        message: 'Private proposal material is unavailable for this selected proposal.'
      }
    }]);
    expect(JSON.stringify(unboundProposalReads)).not.toContain('.soter/state');
    const unboundConnectedProposalFlows = await page.evaluate(async () => {
      const snapshot = await window.soterStudio.getWorkspaceSnapshot();
      const configuration = snapshot.configurations.find((item) => item.name === 'email-triage');
      if (!configuration?.lockFingerprint) throw new Error('Email configuration lock is unavailable.');
      const proposal = {
        proposalId: 'proposal.email-triage.missing',
        configurationName: configuration.name,
        lockFingerprint: configuration.lockFingerprint
      };
      return Promise.all([
        window.soterStudio.previewProposalConnectedBatch({ ...proposal, actionIds: ['action.email.missing.label'] }),
        window.soterStudio.beginProposalConnectedApproval({ proposal, preview: {} as never })
      ]);
    });
    expect(unboundConnectedProposalFlows).toEqual([{
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_BINDING_INVALID',
        message: 'The exact connected proposal preview is unavailable.'
      }
    }, {
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_BINDING_INVALID',
        message: 'The exact connected approval request is unavailable.'
      }
    }]);
    expect(JSON.stringify(unboundConnectedProposalFlows)).not.toContain('.soter/state');
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
    await page.getByRole('link', { name: /Operate/ }).click();
    await page.locator('.catalog-row').filter({ hasText: 'Automation Project Pulse' }).click();
    await expect(page.getByText('Operator workspace · canonical projection')).toBeVisible();
    await expect(page.getByText('Example only · no authority')).toBeVisible();
    await page.getByRole('textbox', { name: 'Project reference' }).fill('https://www.notion.so/11111111111111111111111111111111');
    await page.getByRole('textbox', { name: 'Status date' }).fill('2026-07-20');
    await page.getByRole('combobox', { name: 'Visibility' }).selectOption('Internal');
    await page.getByRole('combobox', { name: 'Project health judgment' }).selectOption('on-track');
    await page.getByRole('textbox', { name: 'Operator note' }).fill('PRIVATE_E2E_NOTE_SENTINEL');
    await prepareContainedRun(page, page.getByText('Private preparation receipt', { exact: true }));
    await expect(page.getByText('Private local review', { exact: true })).toBeVisible();
    await expect(page.locator('.dossier-private-review')).toContainText('PRIVATE_E2E_NOTE_SENTINEL');
    await expect(page.getByText('PREPARATION_READY_FOR_REVIEW')).toBeVisible();
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    const preparedDirectory = path.join(root, '.soter/state/prepared-work');
    expect(fs.existsSync(preparedDirectory)).toBe(true);
    const preparedState = fs.readdirSync(preparedDirectory)
      .map((name) => fs.readFileSync(path.join(preparedDirectory, name), 'utf8'))
      .join('\n');
    expect(preparedState).not.toContain('PRIVATE_E2E_NOTE_SENTINEL');
    const reviewDirectory = path.join(root, '.soter/state/prepared-work-review');
    const reviewState = fs.readdirSync(reviewDirectory)
      .map((name) => fs.readFileSync(path.join(reviewDirectory, name), 'utf8'))
      .join('\n');
    expect(reviewState).toContain('PRIVATE_E2E_NOTE_SENTINEL');
    expect(JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot())))
      .not.toContain('PRIVATE_E2E_NOTE_SENTINEL');
    const projectReviewPath = path.join(reviewDirectory, fs.readdirSync(reviewDirectory)[0]);
    const projectReview = JSON.parse(fs.readFileSync(projectReviewPath, 'utf8'));
    projectReview.fingerprint = 'sha256:' + '0'.repeat(64);
    fs.writeFileSync(projectReviewPath, JSON.stringify(projectReview, null, 2) + '\n');
    const tamperedReviewResult = await page.evaluate(
      (workId) => window.soterStudio.getPreparedWorkReview({ workId }),
      projectReview.workId
    );
    expect(tamperedReviewResult).toEqual({
      ok: false,
      error: {
        code: 'PREPARED_REVIEW_MATERIAL_TAMPERED',
        message: 'Prepared-work review material fingerprint does not match its durable contents.'
      }
    });
    expect(JSON.stringify(tamperedReviewResult)).not.toContain('PRIVATE_E2E_NOTE_SENTINEL');
    await expectAccessible(page);

    await page.locator('.catalog-row').filter({ hasText: 'Automation Meeting Intake' }).click();
    await expect(page.getByRole('heading', { name: 'Automation Meeting Intake' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Transcript meeting reference' }).fill('meeting.fixture-001');
    await page.getByRole('textbox', { name: 'Recording reference' }).fill('https://otter.ai/u/meeting_fixture_001');
    await page.getByRole('textbox', { name: 'Desired outcome' }).fill('PRIVATE_MEETING_E2E_GOAL');
    await prepareContainedRun(page, page.getByText('Meeting Intake preview', { exact: true }));
    await expect(page.getByText('Relationships and follow-up candidates require cited judgment', { exact: true })).toBeVisible();
    await expect(page.getByText('Participant identity resolution', { exact: true })).toBeVisible();
    await expect(page.getByText('0 proposed changes · judgment not performed', { exact: true })).toBeVisible();
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    await expect(page.getByText('Proposed change ledger', { exact: true })).toHaveCount(0);
    await expect(page.locator('.dossier-private-review')).toContainText('https://otter.ai/u/meeting_fixture_001');
    await expect(page.locator('.dossier-private-review')).toContainText('PRIVATE_MEETING_E2E_GOAL');
    const meetingPreparedState = fs.readdirSync(preparedDirectory)
      .map((name) => fs.readFileSync(path.join(preparedDirectory, name), 'utf8'))
      .join('\n');
    const meetingPreparedWork = fs.readdirSync(preparedDirectory)
      .map((name) => JSON.parse(fs.readFileSync(path.join(preparedDirectory, name), 'utf8')))
      .find((work) => work.automation?.id === 'automation.meeting-intake');
    expect(meetingPreparedWork?.id).toBeTruthy();
    expect(meetingPreparedState).not.toContain('https://otter.ai/u/meeting_fixture_001');
    expect(meetingPreparedState).not.toContain('PRIVATE_MEETING_E2E_GOAL');
    const meetingReviewState = fs.readdirSync(reviewDirectory)
      .map((name) => fs.readFileSync(path.join(reviewDirectory, name), 'utf8'))
      .join('\n');
    expect(meetingReviewState).toContain('PRIVATE_MEETING_E2E_GOAL');
    expect(JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot())))
      .not.toContain('PRIVATE_MEETING_E2E_GOAL');
    await expectAccessible(page);

    await page.locator('.catalog-row').filter({ hasText: 'Automation Task Capture' }).click();
    await expect(page.getByRole('heading', { name: 'Automation Task Capture' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Task title' }).fill('PRIVATE_TASK_E2E_TITLE');
    await page.getByRole('textbox', { name: 'Project reference' }).fill('soter-fixture://projects/project/launch');
    await page.getByLabel('Assignee').selectOption('self');
    await page.getByLabel('Next action date').fill('2026-07-24');
    await page.getByLabel('Task context').selectOption('Project');
    await prepareContainedRun(page, page.getByText('Task Capture preview', { exact: true }));
    await expect(page.getByText('Task create scope prepared for review', { exact: true })).toBeVisible();
    const taskEffects = page.getByRole('region', { name: 'Preparation effect boundary' });
    await expect(taskEffects).toContainText('write');
    await expect(taskEffects).toContainText('confirm');
    await expect(taskEffects).toContainText('not executed');
    const taskChange = page.getByRole('region', { name: 'Proposed change fingerprints' });
    await expect(taskChange).toContainText('tasks.records.create');
    await expect(taskChange).toContainText('unavailable');
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    await expect(page.locator('.dossier-private-review')).toContainText('PRIVATE_TASK_E2E_TITLE');
    await expect(page.locator('.dossier-private-review')).toContainText('2026-07-24');
    const taskPreparedState = fs.readdirSync(preparedDirectory)
      .map((name) => fs.readFileSync(path.join(preparedDirectory, name), 'utf8'))
      .join('\n');
    expect(taskPreparedState).not.toContain('PRIVATE_TASK_E2E_TITLE');
    expect(taskPreparedState).not.toContain('2026-07-24');
    const taskReviewState = fs.readdirSync(reviewDirectory)
      .map((name) => fs.readFileSync(path.join(reviewDirectory, name), 'utf8'))
      .join('\n');
    expect(taskReviewState).toContain('PRIVATE_TASK_E2E_TITLE');
    expect(taskReviewState).toContain('2026-07-24');
    expect(JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot())))
      .not.toContain('PRIVATE_TASK_E2E_TITLE');
    expect(JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot())))
      .not.toContain('2026-07-24');
    await expectAccessible(page);

    await page.getByRole('textbox', { name: 'Task title' }).fill('Send launch deck');
    await prepareContainedRun(page, page.getByText('An exact-title task candidate exists and must be reviewed instead of silently creating a duplicate.', { exact: true }));
    await expect(page.getByRole('region', { name: 'Proposed change fingerprints' })).toHaveCount(0);
    await expect(page.getByText('0 proposed changes · held · TASK_CREATE_HELD_FOR_DUPLICATE_REVIEW', { exact: true })).toBeVisible();
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    await expect(page.locator('.operator-confirmation-ceremony button')).toHaveCount(0);

    await page.locator('.catalog-row').filter({ hasText: 'Automation Email Triage' }).click();
    await expect(page.getByRole('heading', { name: 'Automation Email Triage' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Mailbox window query' }).fill('in:inbox newer_than:1d');
    await page.getByLabel('Processing scope').selectOption('triage-drafts-handoffs-digest');
    await page.getByRole('textbox', { name: 'Private focus notes' }).fill('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const emailManifest = page.getByRole('region', { name: 'Prepared review collections' });
    await prepareContainedRun(page, emailManifest);
    await expect(emailManifest).toContainText('15');
    await expect(emailManifest).toContainText('11');
    await expect(emailManifest).toContainText('4');
    await expect(emailManifest).toContainText('NO_ACTIVE_INBOX_MESSAGE_REMOVED');
    await expect(emailManifest).toContainText('EMAIL_SEND_PROHIBITED');
    await expect(page.locator('.review-collection').first()).not.toContainText('in:inbox newer_than:1d');
    await expect(page.locator('.review-collection').first()).not.toContainText('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const privateFolio = page.getByRole('region', { name: 'Selected private derived review' });
    await expect(privateFolio).toContainText('No authority');
    await privateFolio.locator('summary').first().click();
    await expect(privateFolio.locator('dd').first()).toBeVisible();
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    await expect(page.locator('.operator-confirmation-ceremony button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /send/i })).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select Draft for review' }).check();
    await page.getByRole('checkbox', { name: 'Select Label for review' }).first().check();
    await page.getByRole('button', { name: 'Create review-only candidate selection (2)' }).click();
    const candidateSelectionFolio = page.getByRole('region', { name: 'Review-only candidate selection private folio' });
    await expect(candidateSelectionFolio).toBeVisible();
    await expect(candidateSelectionFolio).toContainText('No external action has been taken.');
    await expect(candidateSelectionFolio).toContainText('REVIEW_ONLY_CANDIDATE_PREVIEW_NOT_CREATED');
    await expect(candidateSelectionFolio).toContainText('CONNECTED_VERIFICATION_NOT_PROVEN');
    await expect(candidateSelectionFolio).toContainText('No authority');
    await expect(candidateSelectionFolio.getByRole('button', { name: /approve|confirm|continue|retry|execute|write|send/i })).toHaveCount(0);
    const selectedActions = candidateSelectionFolio.locator('.candidate-selection-actions > li');
    await expect(selectedActions).toHaveCount(2);
    await expect(selectedActions.nth(0)).toContainText('Label');
    await expect(selectedActions.nth(1)).toContainText('Draft');
    await expect(candidateSelectionFolio).toContainText('Exact message IDs');
    await expect(candidateSelectionFolio).toContainText('Exact label name');
    await expect(candidateSelectionFolio).toContainText('Exact reply message ID');
    const candidateSelectionDirectory = path.join(root, '.soter/state/review-only-candidate-selections');
    expect(fs.existsSync(candidateSelectionDirectory)).toBe(true);
    const candidateSelectionState = fs.readdirSync(candidateSelectionDirectory)
      .map((name) => fs.readFileSync(path.join(candidateSelectionDirectory, name), 'utf8')).join('\n');
    expect(candidateSelectionState).not.toContain('No external action has been taken.');
    expect(candidateSelectionState).not.toContain('in:inbox newer_than:1d');
    expect(candidateSelectionState).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    expect(JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot())))
      .not.toContain('No external action has been taken.');

    await candidateSelectionFolio.getByRole('button', { name: 'Create review-only candidate preview' }).click();
    const candidatePreview = page.getByRole('region', { name: 'Selected review-only candidate preview private ledger' });
    await expect(candidatePreview).toBeVisible();
    await expect(candidatePreview).toContainText('Executable');
    await expect(candidatePreview).toContainText('Authority');
    await expect(candidatePreview).toContainText('not declared');
    await expect(candidatePreview).toContainText('provider.integration.gmail.mcp');
    await expect(candidatePreview).toContainText('Create Missing Labels');
    await expect(candidatePreview).toContainText('CONNECTED_PROVIDER_NOT_DECLARED');
    await expect(candidatePreview).toContainText('CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED');
    await expect(candidatePreview).toContainText('CONNECTED_VERIFICATION_NOT_PROVEN');
    await expect(candidatePreview).toContainText('SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE');
    await expect(candidatePreview.locator('.candidate-preview-operations > li')).toHaveCount(2);
    await expect(candidatePreview.getByRole('button')).toHaveCount(0);
    const candidatePreviewDirectory = path.join(root, '.soter/state/review-only-candidate-previews');
    expect(fs.existsSync(candidatePreviewDirectory)).toBe(true);
    const candidatePreviewState = fs.readdirSync(candidatePreviewDirectory)
      .map((name) => fs.readFileSync(path.join(candidatePreviewDirectory, name), 'utf8')).join('\n');
    expect(candidatePreviewState).toContain('No external action has been taken.');
    expect(candidatePreviewState).not.toContain('in:inbox newer_than:1d');
    expect(candidatePreviewState).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const projectionAfterPreview = JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot()));
    expect(projectionAfterPreview).not.toContain('No external action has been taken.');
    expect(projectionAfterPreview).not.toContain('review-only-candidate-preview');
    await expectAccessible(page);
    await candidateSelectionFolio.getByRole('button', { name: 'End candidate review' }).click();
    await expect(candidateSelectionFolio).toHaveCount(0);
    await expect(candidatePreview).toHaveCount(0);

    const emailPreparedState = fs.readdirSync(preparedDirectory)
      .map((name) => fs.readFileSync(path.join(preparedDirectory, name), 'utf8')).join('\n');
    expect(emailPreparedState).not.toContain('in:inbox newer_than:1d');
    expect(emailPreparedState).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const emailReviewState = fs.readdirSync(reviewDirectory)
      .map((name) => fs.readFileSync(path.join(reviewDirectory, name), 'utf8')).join('\n');
    expect(emailReviewState).toContain('in:inbox newer_than:1d');
    expect(emailReviewState).toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const derivedReviewDirectory = path.join(root, '.soter/state/prepared-work-derived-review');
    expect(fs.existsSync(derivedReviewDirectory)).toBe(true);
    const derivedReviewState = fs.readdirSync(derivedReviewDirectory)
      .map((name) => fs.readFileSync(path.join(derivedReviewDirectory, name), 'utf8')).join('\n');
    expect(derivedReviewState).not.toContain('in:inbox newer_than:1d');
    expect(derivedReviewState).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const workspaceProjection = JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot()));
    expect(workspaceProjection).not.toContain('in:inbox newer_than:1d');
    expect(workspaceProjection).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const missingDerivedReview = await page.evaluate(
      (workId) => window.soterStudio.getPreparedWorkDerivedReview({ workId }),
      meetingPreparedWork.id
    );
    expect(missingDerivedReview).toEqual({
      ok: false,
      error: {
        code: 'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING',
        message: 'Private derived review material is unavailable for this prepared work.'
      }
    });
    const missingCandidateSelection = await page.evaluate(() => window.soterStudio.getReviewOnlyCandidateSelectionMaterial({
      selectionId: 'review-only-candidate-selection.email-triage.missing'
    }));
    expect(missingCandidateSelection).toEqual({
      ok: false,
      error: {
        code: 'REVIEW_ONLY_CANDIDATE_SELECTION_MISSING',
        message: 'Private review-only candidate selection material is unavailable.'
      }
    });
    const missingCandidatePreview = await page.evaluate(() => window.soterStudio.getReviewOnlyCandidatePreview({
      candidatePreviewId: 'review-only-candidate-preview.email-triage.missing'
    }));
    expect(missingCandidatePreview).toEqual({
      ok: false,
      error: {
        code: 'REVIEW_ONLY_CANDIDATE_PREVIEW_MISSING',
        message: 'Private review-only candidate preview material is unavailable.'
      }
    });
    const missingApprovalReview = await page.evaluate(() => window.soterStudio.getConnectedApprovalReview({
      requestId: 'approval-request.missing.e2e'
    }));
    expect(missingApprovalReview).toEqual({
      ok: false,
      error: {
        code: 'CONNECTED_APPROVAL_REVIEW_MATERIAL_MISSING',
        message: 'Private approval review material is unavailable for this selected activity.'
      }
    });
    await expectAccessible(page);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.restore();
      window.setSize(1040, 680);
    });
    await page.waitForFunction(() => document.documentElement.clientWidth <= 1080);
    const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth, columns: getComputedStyle(document.querySelector('.operator-workbench')!).gridTemplateColumns }));
    expect(layout.viewport).toBeLessThanOrEqual(1080);
    expect(layout.content).toBeLessThanOrEqual(layout.viewport);
    expect(layout.columns.split(' ').length).toBe(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');

    const initialUrl = page.url();
    await page.evaluate(() => { const anchor = document.createElement('a'); anchor.href = 'https://example.com'; anchor.click(); });
    await page.waitForTimeout(150);
    expect(page.url()).toBe(initialUrl);
    expect(await page.evaluate(() => window.open('https://example.com'))).toBeNull();
  } finally {
    await app.close();
    expect(workspaceFingerprint(root)).toBe(before);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspects exact local release and bundle bytes without exposing paths or executable authority', async () => {
  const root = containedWorkspace();
  const before = workspaceFingerprint(root);
  const artifacts = containedDistributionArtifacts(root);
  const { app, page } = await launch(root);
  try {
    await app.evaluate(({ dialog }, selections) => {
      const queue = [...selections];
      (dialog as unknown as { showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }> }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: queue.shift() || []
      });
    }, [[artifacts.releasePath], [artifacts.bundlePath], [artifacts.releasePath]]);

    await page.getByRole('link', { name: /Releases/ }).click();
    await expect(page.getByRole('heading', { name: 'Sealed release index' })).toBeVisible();
    await page.getByRole('button', { name: 'Inspect local capsule' }).click();
    await expect(page.getByRole('heading', { name: 'kernel.soter' })).toBeVisible();
    await expect(page.getByText('PACK_RELEASE_BYTES_VERIFIED')).toBeVisible();
    await expect(page.getByText('PACK_RELEASE_SOURCE_NOT_EVALUATED')).toBeVisible();
    await expect(page.getByText('Byte facts stop before trust and runtime claims.')).toBeVisible();

    await page.getByRole('button', { name: 'Inspect local bundle' }).click();
    await expect(page.getByRole('heading', { name: 'bundle.studio-contained' })).toBeVisible();
    await expect(page.getByText('BUNDLE_RESOLVED')).toBeVisible();
    await expect(page.getByText('unsigned-untrusted').first()).toBeVisible();
    const bundleLedger = page.getByRole('article', { name: 'Bundle bundle.studio-contained' });
    await expect(bundleLedger.getByRole('button', { name: /install|configure|realize|publish|redistribute|marketplace|auto-update/i })).toHaveCount(0);

    const rendered = await page.locator('body').innerText();
    expect(rendered).not.toContain(root);
    expect(rendered).not.toContain(artifacts.outputRoot);
    expect(rendered).not.toContain(artifacts.releasePath);
    expect(rendered).not.toContain(artifacts.bundlePath);
    expect(rendered).not.toContain('contentEncoding');
    expect(workspaceFingerprint(root)).toBe(before);
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
  } finally {
    await app.close();
    expect(workspaceFingerprint(root)).toBe(before);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(artifacts.outputRoot, { recursive: true, force: true });
  }
});

test('installs one exact local release only through the canonical checkpoint transaction', async () => {
  const root = containedWorkspace();
  const before = workspaceFingerprint(root);
  const artifacts = containedDistributionArtifacts(root);
  const target = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-studio-install-target-'));
  const { app, page } = await launch(root);
  try {
    await app.evaluate(({ dialog }, selections) => {
      const queue = [...selections];
      (dialog as unknown as { showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }> }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: queue.shift() || []
      });
    }, [[target], [artifacts.releasePath]]);

    await page.getByRole('link', { name: /Releases/ }).click();
    const hostile = await page.evaluate(async () => {
      const request = window.soterStudio.beginPackInstallRequest as unknown as (value: Record<string, unknown>) => Promise<unknown>;
      return request({ planId: 'pack-install-plan.missing', targetRoot: '/private/PACK_INSTALL_TARGET_SENTINEL' });
    });
    expect(hostile).toEqual({
      ok: false,
      error: { code: 'PACK_INSTALL_ADAPTER_UNAVAILABLE', message: 'The exact local pack install operation is unavailable.' }
    });

    await page.getByRole('button', { name: 'Select target and local releases' }).click();
    await expect(page.getByText('PACK_INSTALL_DEPENDENCIES_RESOLVED')).toBeVisible();
    await expect(page.getByText('Paths and bytes withheld')).toBeVisible();
    let rendered = await page.locator('body').innerText();
    expect(rendered).not.toContain(target);
    expect(rendered).not.toContain(artifacts.outputRoot);
    expect(rendered).not.toContain(artifacts.releasePath);
    expect(rendered).not.toContain('PACK_INSTALL_TARGET_SENTINEL');
    expect(fs.existsSync(path.join(target, 'soter/packs/kernel.soter/pack.json'))).toBe(false);

    await page.getByRole('button', { name: 'Request confirmation' }).click();
    await page.getByLabel('I reviewed this exact fingerprint-bound install plan.').check();
    await page.getByRole('button', { name: 'Confirm exact install request' }).click();
    await page.getByRole('button', { name: 'Start this exact install plan' }).click();
    const execute = page.getByRole('button', { name: 'Install exact checkpoint' });
    await expect(execute).toBeDisabled();
    await page.getByLabel("I understand this changes only the selected target's managed pack files.").check();
    await expect(execute).toBeEnabled();
    await execute.click();
    await expect(page.getByText('PACK_INSTALL_COMPLETED').first()).toBeVisible();
    await expect(page.getByText('Materialized locally does not mean configured or working.')).toBeVisible();

    expect(fs.existsSync(path.join(target, 'soter/packs/kernel.soter/pack.json'))).toBe(true);
    const manifest = path.join(target, '.soter/state/pack-install-manifests/managed.json');
    expect(fs.existsSync(manifest)).toBe(true);
    expect((fs.statSync(manifest).mode & 0o777).toString(8).padStart(4, '0')).toBe('0600');
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).lastSuccessfulCheckpoint.id).toMatch(/^checkpoint\.pack-install\./);
    rendered = await page.locator('body').innerText();
    expect(rendered).not.toContain(target);
    expect(rendered).not.toContain(artifacts.releasePath);
    expect(rendered).not.toContain('contentEncoding');
    expect(workspaceFingerprint(root)).toBe(before);
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
  } finally {
    await app.close();
    expect(workspaceFingerprint(root)).toBe(before);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(artifacts.outputRoot, { recursive: true, force: true });
  }
});

test('renders the canonical lifecycle coverage without enabling fixture authority', async () => {
  const root = containedWorkspace();
  const { app, page } = await launch(root);
  try {
    await page.getByRole('link', { name: /Operate/ }).click();
    await page.locator('.catalog-row').filter({ hasText: 'Automation Project Pulse' }).click();
    const states = page.getByRole('list', { name: 'Sanitized operator lifecycle examples' });
    await expect(states).toBeVisible();
    await states.getByRole('button', { name: /verification failed/ }).click();
    await expect(page.getByText('RECONCILIATION_AVAILABLE')).toBeVisible();
    await expect(page.getByText('failed', { exact: true }).first()).toBeVisible();
    const recovery = page.getByRole('region', { name: 'Exact checkpoint recovery' });
    await expect(recovery).toBeVisible();
    await expect(recovery.getByText('Completed prefix')).toBeVisible();
    await expect(recovery.getByText('Exact current step')).toBeVisible();
    await expect(recovery.getByText('Remaining')).toBeVisible();
    await expect(recovery.getByRole('button', { name: 'No executable continuation' })).toBeDisabled();
    await states.getByRole('button', { name: /private basis unavailable/ }).click();
    await expect(page.getByText('CONFIGURATION_BASIS_NOT_PRIVATE_ACTIVE')).toBeVisible();
    await expect(page.getByRole('button', { name: 'No executable continuation' })).toBeDisabled();
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
    expect(fs.existsSync(path.join(root, '.soter'))).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first-use typed onboarding seals, resumes, and applies only the exact private configuration transaction', async () => {
  const root = containedWorkspace();
  const configurationName = 'slack-conversation-review';
  const source = path.join(root, 'soter/configurations', configurationName + '.config.json');
  const fixtureLock = path.join(root, 'soter/fixtures/slack-conversation-review/slack-conversation-review.lock.json');
  const sourceBefore = fs.readFileSync(source, 'utf8');
  const fixtureLockBefore = fs.readFileSync(fixtureLock, 'utf8');
  const workspaceBefore = workspaceFingerprint(root);
  const { app, page } = await launch(root);
  try {
    await page.evaluate((name) => { window.location.hash = '#/config/' + name; }, configurationName);
    await expect(page.getByText('Exact lock transfer')).toBeVisible();
    await expect(page.getByText('Blank private setup')).toBeVisible();

    const oversized = await page.evaluate(async (name) => window.soterStudio.prepareConfigurationOnboarding({
      name,
      descriptionFingerprint: 'sha256:' + '0'.repeat(64),
      slots: Array.from({ length: 501 }, (_value, index) => ({ id: 'oversized-' + index, state: 'omitted' as const }))
    }), configurationName);
    expect(oversized).toEqual({
      ok: false,
      error: {
        code: 'CONFIGURATION_ADAPTER_UNAVAILABLE',
        message: 'The exact private onboarding plan is unavailable.'
      }
    });
    expect(fs.existsSync(path.join(root, '.soter/state/configuration-change-plans'))).toBe(false);

    const privateValues = {
      communications: 'soter://authority/communications-e2e',
      slack: 'soter://authority/slack-e2e',
      policies: 'collection://0123456789abcdef0123456789abcdef',
      workspace: 'TSTUDIOE2E',
      property: 'Policy name',
      policyId: 'PRIVATE_CONVERSATION_REVIEW_POLICY_E2E_ID'
    };
    await page.getByLabel('URI — Authority communications instance').fill(privateValues.communications);
    await page.getByLabel('URI — Authority slack instance').fill(privateValues.slack);
    await page.getByLabel('Policies — Integration notion').fill(privateValues.policies);
    await page.getByLabel('Workspace id — Integration slack').fill(privateValues.workspace);
    await page.getByLabel('Provider property — Conversation review policy · Name').fill(privateValues.property);
    const policyId = page.getByLabel('Item 1');
    await expect(policyId).toHaveCount(1);
    await expect(policyId).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add list item' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove item 1' })).toBeDisabled();
    await policyId.fill(privateValues.policyId);
    await page.getByRole('button', { name: 'Seal first-use plan' }).click();
    await expect(page.getByText('Fingerprint-only scope')).toBeVisible();
    for (const value of Object.values(privateValues)) {
      await expect(page.getByText(value, { exact: false })).toHaveCount(0);
    }
    const assertBrowserPrivacy = async () => {
      const state = await page.evaluate(async () => ({
        href: window.location.href,
        localStorage: { ...window.localStorage },
        sessionStorage: { ...window.sessionStorage },
        text: document.body.textContent,
        attributes: Array.from(document.querySelectorAll('*')).flatMap((element) => (
          Array.from(element.attributes).map((attribute) => attribute.value)
        )),
        snapshot: await window.soterStudio.getWorkspaceSnapshot()
      }));
      const serialized = JSON.stringify(state);
      for (const value of Object.values(privateValues)) expect(serialized).not.toContain(value);
    };
    await assertBrowserPrivacy();
    await page.getByRole('button', { name: 'Request confirmation' }).click();
    await page.getByLabel('I reviewed this exact fingerprint-only scope.').check();
    await page.getByRole('button', { name: 'Confirm exact request' }).click();

    const confirmationDirectory = path.join(root, '.soter/state/configuration-change-confirmations');
    const [confirmationFile] = fs.readdirSync(confirmationDirectory).filter((file) => file.endsWith('.json'));
    expect(confirmationFile).toBeTruthy();
    const confirmation = JSON.parse(fs.readFileSync(path.join(confirmationDirectory, confirmationFile), 'utf8')) as {
      id: string;
    };
    const hostileCheckpointId = 'checkpoint.configuration.hostile-fresh-resume';
    const hostileResume = await page.evaluate(
      ({ confirmationId, checkpointId }) => window.soterStudio.startConfigurationChange({ confirmationId, checkpointId }),
      { confirmationId: confirmation.id, checkpointId: hostileCheckpointId }
    );
    expect(hostileResume).toEqual({
      ok: false,
      error: {
        code: 'CONFIGURATION_CONSUMPTION_MISSING',
        message: 'The one-time configuration start is unavailable.'
      }
    });
    const consumptionDirectory = path.join(root, '.soter/state/configuration-change-consumptions');
    expect(fs.existsSync(consumptionDirectory)
      ? fs.readdirSync(consumptionDirectory).filter((file) => file.endsWith('.json'))
      : []).toEqual([]);
    expect(fs.existsSync(path.join(
      root,
      '.soter/state/configuration-transactions',
      `${hostileCheckpointId}.json`
    ))).toBe(false);
    await expect(page.getByRole('button', { name: 'Reserve one-time start' })).toBeEnabled();
    await page.getByRole('button', { name: 'Reserve one-time start' }).click();
    const apply = page.getByRole('button', { name: 'Apply exact checkpoint' });
    await expect(apply).toBeDisabled();
    await page.getByLabel('I understand this changes the local desired configuration.').check();
    await expect(apply).toBeEnabled();
    await page.getByLabel('I understand this changes the local desired configuration.').uncheck();
    await expect(apply).toBeDisabled();
    await expect(page.getByText('Core-derived guidance · not authority')).toBeVisible();

    const [consumptionFile] = fs.readdirSync(consumptionDirectory).filter((file) => file.endsWith('.json'));
    const consumptionPath = path.join(consumptionDirectory, consumptionFile);
    const startedConsumption = JSON.parse(fs.readFileSync(consumptionPath, 'utf8')) as {
      id: string;
      createdAt: string;
      updatedAt: string;
      state: 'reserved' | 'started';
      plan: { id: string };
      request: { id: string };
      confirmation: { id: string };
      checkpointId: string;
      checkpointFingerprint: string | null;
      consumptionFingerprint: string;
    };
    expect(startedConsumption.state).toBe('started');
    expect(startedConsumption.checkpointId).toMatch(/^checkpoint\.configuration\.[a-f0-9-]+$/);
    const checkpointPath = path.join(
      root,
      '.soter/state/configuration-transactions',
      `${startedConsumption.checkpointId}.json`
    );
    expect(fs.existsSync(checkpointPath)).toBe(true);

    const reservedConsumption: Record<string, unknown> = {
      ...startedConsumption,
      updatedAt: startedConsumption.createdAt,
      state: 'reserved' as const,
      checkpointFingerprint: null
    };
    delete reservedConsumption.consumptionFingerprint;
    reservedConsumption.consumptionFingerprint = fingerprintJson(reservedConsumption);
    fs.writeFileSync(consumptionPath, JSON.stringify(reservedConsumption, null, 2) + '\n');
    fs.rmSync(checkpointPath);

    const existingTransaction = page.locator('.configuration-existing-transaction');
    await existingTransaction.getByText('Open an existing exact transaction').click();
    await existingTransaction.getByLabel('Plan ID').fill(startedConsumption.plan.id);
    await existingTransaction.getByLabel('Request ID').fill(startedConsumption.request.id);
    await existingTransaction.getByLabel('Confirmation ID').fill(startedConsumption.confirmation.id);
    await existingTransaction.getByLabel('Checkpoint ID').fill('');
    await existingTransaction.getByRole('button', { name: 'Inspect exact references' }).click();
    const resume = page.getByRole('button', { name: 'Resume exact reserved start' });
    await expect(resume).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Reserve one-time start' })).toHaveCount(0);
    await resume.click();
    await expect(page.getByRole('button', { name: 'Apply exact checkpoint' })).toBeDisabled();

    const resumedConsumption = JSON.parse(fs.readFileSync(consumptionPath, 'utf8')) as {
      state: string;
      checkpointId: string;
    };
    expect(resumedConsumption.state).toBe('started');
    expect(resumedConsumption.checkpointId).toBe(startedConsumption.checkpointId);
    expect(fs.existsSync(checkpointPath)).toBe(true);

    const applyAfterResume = page.getByRole('button', { name: 'Apply exact checkpoint' });
    await page.getByLabel('I understand this changes the local desired configuration.').check();
    await expect(applyAfterResume).toBeEnabled();
    await applyAfterResume.click();
    await expect(page.getByText('completed', { exact: true }).first()).toBeVisible();

    const desiredPath = path.join(root, '.soter/state/configurations', configurationName + '.json');
    const lockPath = path.join(root, '.soter/state/configuration-locks', configurationName + '.json');
    expect(fs.existsSync(desiredPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    const desiredConfiguration = JSON.parse(fs.readFileSync(desiredPath, 'utf8')) as {
      sources: Array<{ id: string; input: { ids?: string[] } }>;
    };
    const policySources = desiredConfiguration.sources.filter(({ id }) => id === 'source.policy.conversation-review');
    expect(policySources).toHaveLength(1);
    expect(policySources[0].input.ids).toEqual([privateValues.policyId]);
    expect(fs.statSync(desiredPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(desiredPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(lockPath)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(source, 'utf8')).toBe(sourceBefore);
    expect(fs.readFileSync(fixtureLock, 'utf8')).toBe(fixtureLockBefore);
    expect(workspaceFingerprint(root)).toBe(workspaceBefore);
    for (const forbiddenState of [
      'host-calls',
      'provider-probes',
      'connected-transactions',
      'host-realization-plans',
      'host-realizations'
    ]) {
      expect(fs.existsSync(path.join(root, '.soter/state', forbiddenState))).toBe(false);
    }
    await page.evaluate(() => { window.location.hash = '#/config/meeting-intake'; });
    await expect(page).toHaveURL(/#\/config\/meeting-intake$/);
    await assertBrowserPrivacy();
    await expect(page.getByText('Blank private setup')).toBeVisible({ timeout: 45_000 });
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host realization executes and verifies only inside the contained consumer', async () => {
  const root = containedHostConsumer();
  const containedBefore = nonPrivateWorkspaceFiles(root);
  const canonicalHostSourcesBefore = workspaceFingerprint(path.join(repositoryRoot, 'soter/hosts'));
  const { app, page } = await launch(root);
  try {
    const hostile = await page.evaluate(async () => {
      const operation = window.soterStudio.prepareHostRealization as unknown as (request: Record<string, unknown>) => Promise<unknown>;
      return operation({ configurationName: 'meeting-intake', consumerRoot: '/private/consumer/root', templateBytes: 'HOST_TEMPLATE_BYTES_SENTINEL' });
    });
    expect(hostile).toEqual({
      ok: false,
      error: { code: 'HOST_REALIZATION_ADAPTER_UNAVAILABLE', message: 'The exact private host realization plan is unavailable.' }
    });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 760));
    await page.evaluate(() => { window.location.hash = '#/config/meeting-intake'; });
    const plan = page.getByRole('button', { name: 'Prepare host projection' });
    await expect(plan).toBeVisible();
    await plan.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Ordered whole-file scope')).toBeVisible();
    await expect(page.getByText('AGENTS.md')).toBeVisible();
    await expect(page.getByText('.codex/config.toml')).toBeVisible();
    expect(await page.locator('.host-realization-workbench').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
    expect(await page.locator('body').innerText()).not.toContain('/private/consumer/root');
    expect(await page.locator('body').innerText()).not.toContain('HOST_TEMPLATE_BYTES_SENTINEL');
    expect(await page.locator('body').innerText()).not.toContain(privateMeetingOptionPrefix);

    await page.getByRole('button', { name: 'Request confirmation' }).click();
    await page.getByLabel('I reviewed every relative path, effect, mode, and fingerprint.').check();
    await page.getByRole('button', { name: 'Confirm exact request' }).click();
    await page.getByRole('button', { name: 'Reserve one-time start' }).click();
    const realize = page.getByRole('button', { name: 'Realize exact checkpoint' });
    await expect(realize).toBeDisabled();
    await page.getByLabel('I understand this changes managed host files in the current launch root.').check();
    await expect(realize).toBeEnabled();
    const privatePlanDirectory = path.join(root, '.soter/state/host-realization-plans');
    const [privatePlanFile] = fs.readdirSync(privatePlanDirectory).filter((file) => file.endsWith('.json'));
    const privatePlan = JSON.parse(fs.readFileSync(path.join(privatePlanDirectory, privatePlanFile), 'utf8')) as {
      operations: Array<{
        path: string;
        after: { state: 'absent' | 'present'; content: string | null; mode: string | null };
      }>;
    };
    await realize.click();
    await expect(page.getByText('Local projection', { exact: true })).toBeVisible();
    await expect(page.locator('.host-realization-claim').filter({ hasText: 'Local projection' })).toContainText('passed');
    for (const claim of ['Host launch', 'Tool discovery', 'Authentication', 'Provider reachability', 'Connected behavior', 'Health']) {
      await expect(page.locator('.host-realization-claim').filter({ hasText: claim })).toContainText('unknown');
    }

    for (const operation of privatePlan.operations) {
      const target = path.join(root, operation.path);
      if (operation.after.state === 'absent') {
        expect(fs.existsSync(target)).toBe(false);
        continue;
      }
      expect(fs.readFileSync(target, 'utf8')).toBe(operation.after.content);
      expect((fs.statSync(target).mode & 0o777).toString(8).padStart(4, '0')).toBe(operation.after.mode);
    }
    expect(fs.existsSync(path.join(root, '.soter/state/host-realization-plans'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.soter/state/host-realization-checkpoints'))).toBe(true);
    const manifest = path.join(root, '.soter/state/host-projections/codex.json');
    expect(fs.existsSync(manifest)).toBe(true);
    expect((fs.statSync(manifest).mode & 0o777).toString(8).padStart(4, '0')).toBe('0600');
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).manifestFingerprint).toBeTruthy();

    const containedAfter = nonPrivateWorkspaceFiles(root);
    const added = [...containedAfter.keys()].filter((file) => !containedBefore.has(file)).sort();
    expect(added).toEqual(['.codex/config.toml', 'AGENTS.md']);
    for (const [file, before] of containedBefore) expect(containedAfter.get(file)).toEqual(before);
    expect(workspaceFingerprint(path.join(repositoryRoot, 'soter/hosts'))).toBe(canonicalHostSourcesBefore);
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical file changes invalidate and refresh through Core', async () => {
  const root = containedWorkspace();
  const { app, page } = await launch(root);
  // The production file watcher can be scheduled behind earlier packaged
  // Electron scenarios on a loaded host. Keep this bounded, but allow the
  // same refresh that passes immediately in isolation to complete in-suite.
  const watcherRefreshTimeout = 30_000;
  try {
    const source = path.join(root, 'soter/capabilities/crm.records.read.json');
    const target = path.join(root, 'soter/capabilities/studio.test.read.json');
    const capability = JSON.parse(fs.readFileSync(source, 'utf8'));
    capability.id = 'studio.test.read';
    capability.purpose = 'Contained inspection capability used only to prove watcher invalidation.';
    fs.writeFileSync(target, JSON.stringify(capability, null, 2) + '\n');
    await expect(page.locator('.catalog-panel').getByText('Studio Test Read')).toBeVisible({ timeout: watcherRefreshTimeout });
    const privateCalls = path.join(root, '.soter/state/host-calls');
    fs.mkdirSync(privateCalls, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(privateCalls, 'malformed.json'), '{not-json\n');
    await expect(page.getByText('SOTER_INSPECTION_RUNTIME_JSON_INVALID')).toBeAttached({ timeout: watcherRefreshTimeout });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function expectAccessible(page: Page) {
  const accessibility = await page.evaluate(() => (window as unknown as { axe: { run: (document: Document, options: object) => Promise<{ violations: unknown[] }> } }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
  expect(accessibility.violations).toEqual([]);
}
