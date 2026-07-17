import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error The canonical Kernel distribution module is checked JavaScript without declarations.
import { buildBundle, buildPackRelease } from '../../../kernel/distribution.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, '../../../..');
const axeSource = fs.readFileSync(path.join(repositoryRoot, 'node_modules/axe-core/axe.min.js'), 'utf8');

test.setTimeout(90_000);

function containedWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-studio-e2e-'));
  for (const name of ['soter', '.claude', '.codex']) fs.cpSync(path.join(repositoryRoot, name), path.join(root, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.studio.json', 'AGENTS.md', 'CLAUDE.md']) fs.copyFileSync(path.join(repositoryRoot, name), path.join(root, name));
  return root;
}

function containedHostConsumer() {
  const root = containedWorkspace();
  fs.rmSync(path.join(root, 'AGENTS.md'), { force: true });
  fs.rmSync(path.join(root, '.codex'), { recursive: true, force: true });
  const activeLocks = path.join(root, '.soter/state/configuration-locks');
  fs.mkdirSync(activeLocks, { recursive: true });
  fs.copyFileSync(
    path.join(root, 'soter/fixtures/meeting-intake/meeting-intake.lock.json'),
    path.join(activeLocks, 'meeting-intake.json')
  );
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

test('launches with a sandboxed canonical adapter and performs zero workspace writes while browsing', async () => {
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
      api: ['beginConfigurationChangeRequest', 'beginHostRealizationRequest', 'beginProposalConnectedApproval', 'confirmConfigurationChangeRequest', 'confirmConnectedApproval', 'confirmHostRealizationRequest', 'createPreparedConnectedPlan', 'createPreparedReviewBatch', 'executeConfigurationChange', 'executeHostRealization', 'getAutomationProposal', 'getAutomationProposalMaterial', 'getConnectedApprovalReview', 'getOperatorActivity', 'getPreparedConnectedPlan', 'getPreparedReviewBatchMaterial', 'getPreparedWork', 'getPreparedWorkDerivedReview', 'getPreparedWorkReview', 'getWorkspaceSnapshot', 'inspectConfigurationChange', 'inspectHostRealization', 'inspectLocalBundle', 'inspectLocalPackRelease', 'onWorkspaceInvalidated', 'prepareAutomationRun', 'prepareConfigurationChange', 'prepareConnectedReconciliation', 'prepareHostRealization', 'previewConfiguration', 'previewProposalConnectedBatch', 'recoverConfigurationChange', 'recoverHostRealization', 'refreshWorkspaceSnapshot', 'startConfigurationChange', 'startConnectedTransaction', 'startHostRealization']
    });
    const productionCsp = await page.evaluate(async () => {
      const response = await fetch(window.location.href);
      return response.headers.get('content-security-policy');
    });
    expect(productionCsp).toContain("connect-src 'self'");
    expect(productionCsp).not.toContain('127.0.0.1');
    expect(productionCsp).not.toContain('ws://');
    const missingProposalReads = await page.evaluate(async () => {
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
    expect(missingProposalReads).toEqual([{
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_MISSING',
        message: 'The selected review-only proposal is unavailable.'
      }
    }, {
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_MISSING',
        message: 'Private proposal material is unavailable for this selected proposal.'
      }
    }]);
    expect(JSON.stringify(missingProposalReads)).not.toContain('.soter/state');
    const missingConnectedProposalFlows = await page.evaluate(async () => {
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
    expect(missingConnectedProposalFlows).toEqual([{
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_MISSING',
        message: 'The exact connected proposal preview is unavailable.'
      }
    }, {
      ok: false,
      error: {
        code: 'AUTOMATION_PROPOSAL_MISSING',
        message: 'The exact connected approval request is unavailable.'
      }
    }]);
    expect(JSON.stringify(missingConnectedProposalFlows)).not.toContain('.soter/state');
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
    await page.getByRole('link', { name: /Operate/ }).click();
    await page.locator('.catalog-row').filter({ hasText: 'Automation Project Pulse' }).click();
    await expect(page.getByText('Operator workspace · canonical projection')).toBeVisible();
    await expect(page.getByText('Example only · no authority')).toBeVisible();
    await page.getByRole('textbox', { name: 'Project reference' }).fill('project.pulse-risk');
    await page.getByRole('textbox', { name: 'Operator note' }).fill('PRIVATE_E2E_NOTE_SENTINEL');
    await page.getByRole('button', { name: 'Prepare contained run' }).click();
    await expect(page.getByText('Private preparation receipt', { exact: true })).toBeVisible();
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
    await page.getByRole('textbox', { name: 'Recording reference' }).fill('otter://fixture/meeting.fixture-001');
    await page.getByRole('textbox', { name: 'Desired outcome' }).fill('PRIVATE_MEETING_E2E_GOAL');
    await page.getByRole('button', { name: 'Prepare contained run' }).click();
    await expect(page.getByText('Meeting Intake preview', { exact: true })).toBeVisible();
    await expect(page.getByText('Relationships and follow-up candidates require cited judgment', { exact: true })).toBeVisible();
    await expect(page.getByText('Participant identity resolution', { exact: true })).toBeVisible();
    await expect(page.getByText('0 proposed changes · judgment not performed', { exact: true })).toBeVisible();
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    await expect(page.getByText('Proposed change ledger', { exact: true })).toHaveCount(0);
    await expect(page.locator('.dossier-private-review')).toContainText('otter://fixture/meeting.fixture-001');
    await expect(page.locator('.dossier-private-review')).toContainText('PRIVATE_MEETING_E2E_GOAL');
    const meetingPreparedState = fs.readdirSync(preparedDirectory)
      .map((name) => fs.readFileSync(path.join(preparedDirectory, name), 'utf8'))
      .join('\n');
    expect(meetingPreparedState).not.toContain('otter://fixture/meeting.fixture-001');
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
    await page.getByRole('textbox', { name: 'Project reference' }).fill('soter-fixture://crm/project/launch');
    await page.getByRole('textbox', { name: 'Assignee reference' }).fill('provider-person.maya');
    await page.getByLabel('Next action date').fill('2026-07-24');
    await page.getByLabel('Task context').selectOption('Project');
    await page.getByRole('button', { name: 'Prepare contained run' }).click();
    await expect(page.getByText('Task Capture preview', { exact: true })).toBeVisible();
    await expect(page.getByText('Task create scope prepared for review', { exact: true })).toBeVisible();
    const taskEffects = page.getByRole('region', { name: 'Preparation effect boundary' });
    await expect(taskEffects).toContainText('write');
    await expect(taskEffects).toContainText('confirm');
    await expect(taskEffects).toContainText('not executed');
    const taskChange = page.getByRole('region', { name: 'Proposed change fingerprints' });
    await expect(taskChange).toContainText('crm.records.create');
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
    await page.getByRole('button', { name: 'Prepare contained run' }).click();
    await expect(page.getByText('An exact-title task candidate exists and must be reviewed instead of silently creating a duplicate.', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Proposed change fingerprints' })).toHaveCount(0);
    await expect(page.getByText('0 proposed changes · write not proposed', { exact: true })).toBeVisible();
    await expect(page.getByText('No approval request', { exact: true })).toBeVisible();
    await expect(page.locator('.operator-confirmation-ceremony button')).toHaveCount(0);

    await page.locator('.catalog-row').filter({ hasText: 'Automation Email Triage' }).click();
    await expect(page.getByRole('heading', { name: 'Automation Email Triage' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Mailbox window query' }).fill('in:inbox newer_than:1d');
    await page.getByLabel('Processing scope').selectOption('triage-drafts-handoffs-digest');
    await page.getByRole('textbox', { name: 'Private focus notes' }).fill('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    await page.getByRole('button', { name: 'Prepare contained run' }).click();
    const emailManifest = page.getByRole('region', { name: 'Prepared review collections' });
    await expect(emailManifest).toBeVisible();
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
    await page.getByRole('button', { name: 'Create review-only batch (2)' }).click();
    const selectedBatchFolio = page.getByRole('region', { name: 'Selected review batch private folio' });
    await expect(selectedBatchFolio).toBeVisible();
    await expect(selectedBatchFolio).toContainText('No external action has been taken.');
    await expect(selectedBatchFolio).toContainText('CONNECTED_PLAN_NOT_COMPILED');
    await expect(selectedBatchFolio).toContainText('CONNECTED_VERIFICATION_NOT_PROVEN');
    await expect(selectedBatchFolio).toContainText('No authority');
    await expect(selectedBatchFolio.getByRole('button', { name: /approve|confirm|continue|retry|execute|write|send/i })).toHaveCount(0);
    const selectedActions = selectedBatchFolio.locator('.selected-batch-actions > li');
    await expect(selectedActions).toHaveCount(2);
    await expect(selectedActions.nth(0)).toContainText('Label');
    await expect(selectedActions.nth(1)).toContainText('Draft');
    await expect(selectedBatchFolio).toContainText('Exact message IDs');
    await expect(selectedBatchFolio).toContainText('Exact label name');
    await expect(selectedBatchFolio).toContainText('Exact reply message ID');
    const reviewBatchDirectory = path.join(root, '.soter/state/prepared-review-batches');
    expect(fs.existsSync(reviewBatchDirectory)).toBe(true);
    const reviewBatchState = fs.readdirSync(reviewBatchDirectory)
      .map((name) => fs.readFileSync(path.join(reviewBatchDirectory, name), 'utf8')).join('\n');
    expect(reviewBatchState).not.toContain('No external action has been taken.');
    expect(reviewBatchState).not.toContain('in:inbox newer_than:1d');
    expect(reviewBatchState).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    expect(JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot())))
      .not.toContain('No external action has been taken.');

    await selectedBatchFolio.getByRole('button', { name: 'Compile review-only candidate' }).click();
    const compiledCandidate = page.getByRole('region', { name: 'Selected compiled candidate private ledger' });
    await expect(compiledCandidate).toBeVisible();
    await expect(compiledCandidate).toContainText('Executable');
    await expect(compiledCandidate).toContainText('Authority');
    await expect(compiledCandidate).toContainText('not declared');
    await expect(compiledCandidate).toContainText('provider.integration.gmail.mcp');
    await expect(compiledCandidate).toContainText('Create Missing Labels');
    await expect(compiledCandidate).toContainText('CONNECTED_PROVIDER_NOT_DECLARED');
    await expect(compiledCandidate).toContainText('CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED');
    await expect(compiledCandidate).toContainText('CONNECTED_VERIFICATION_NOT_PROVEN');
    await expect(compiledCandidate).toContainText('SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE');
    await expect(compiledCandidate.locator('.compiled-candidate-operations > li')).toHaveCount(2);
    await expect(compiledCandidate.getByRole('button')).toHaveCount(0);
    const connectedPlanDirectory = path.join(root, '.soter/state/prepared-connected-plans');
    expect(fs.existsSync(connectedPlanDirectory)).toBe(true);
    const connectedPlanState = fs.readdirSync(connectedPlanDirectory)
      .map((name) => fs.readFileSync(path.join(connectedPlanDirectory, name), 'utf8')).join('\n');
    expect(connectedPlanState).toContain('No external action has been taken.');
    expect(connectedPlanState).not.toContain('in:inbox newer_than:1d');
    expect(connectedPlanState).not.toContain('PRIVATE_EMAIL_E2E_FOCUS_SENTINEL');
    const projectionAfterPlan = JSON.stringify(await page.evaluate(() => window.soterStudio.getWorkspaceSnapshot()));
    expect(projectionAfterPlan).not.toContain('No external action has been taken.');
    expect(projectionAfterPlan).not.toContain('prepared-connected-plan');
    await expectAccessible(page);
    await selectedBatchFolio.getByRole('button', { name: 'End batch review' }).click();
    await expect(selectedBatchFolio).toHaveCount(0);
    await expect(compiledCandidate).toHaveCount(0);

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
      projectReview.workId
    );
    expect(missingDerivedReview).toEqual({
      ok: false,
      error: {
        code: 'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING',
        message: 'Private derived review material is unavailable for this prepared work.'
      }
    });
    const missingReviewBatch = await page.evaluate(() => window.soterStudio.getPreparedReviewBatchMaterial({
      batchId: 'review-batch.email-triage.missing'
    }));
    expect(missingReviewBatch).toEqual({
      ok: false,
      error: {
        code: 'PREPARED_REVIEW_BATCH_MISSING',
        message: 'Private selected-batch review material is unavailable.'
      }
    });
    const missingConnectedPlan = await page.evaluate(() => window.soterStudio.getPreparedConnectedPlan({
      planId: 'prepared-connected-plan.email-triage.missing'
    }));
    expect(missingConnectedPlan).toEqual({
      ok: false,
      error: {
        code: 'PREPARED_CONNECTED_PLAN_MISSING',
        message: 'Private compiled candidate material is unavailable.'
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
    await expect(page.getByRole('button', { name: /install|configure|realize|publish|redistribute|marketplace|auto-update/i })).toHaveCount(0);

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
    await states.getByRole('button', { name: /rolled back/ }).click();
    await expect(page.getByText('TRANSACTION_ROLLED_BACK')).toBeVisible();
    await expect(page.getByRole('button', { name: 'No executable continuation' })).toBeDisabled();
    await app.evaluate(async ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), axeSource);
    await expectAccessible(page);
    expect(fs.existsSync(path.join(root, '.soter'))).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configuration ceremony reaches a one-time local checkpoint without applying it', async () => {
  const root = containedWorkspace();
  const source = path.join(root, 'soter/configurations/meeting-intake.config.json');
  const fixtureLock = path.join(root, 'soter/fixtures/meeting-intake/meeting-intake.lock.json');
  const sourceBefore = fs.readFileSync(source, 'utf8');
  const fixtureLockBefore = fs.readFileSync(fixtureLock, 'utf8');
  const workspaceBefore = workspaceFingerprint(root);
  const candidate = JSON.parse(sourceBefore);
  candidate.host = {
    id: 'claude',
    adapter: 'host.claude',
    version: '0.1.0',
    reason: 'Use the declared Claude projection for this exact local configuration transaction.'
  };
  const { app, page } = await launch(root);
  try {
    await page.evaluate(() => { window.location.hash = '#/config/meeting-intake'; });
    await expect(page.getByText('Exact lock transfer')).toBeVisible();
    await page.getByLabel('Complete private candidate').fill(JSON.stringify(candidate));
    await page.getByRole('button', { name: 'Seal exact private plan' }).click();
    await expect(page.getByText('Fingerprint-only scope')).toBeVisible();
    await page.getByRole('button', { name: 'Request confirmation' }).click();
    await page.getByLabel('I reviewed this exact fingerprint-only scope.').check();
    await page.getByRole('button', { name: 'Confirm exact request' }).click();
    await page.getByRole('button', { name: 'Reserve one-time start' }).click();
    const apply = page.getByRole('button', { name: 'Apply exact checkpoint' });
    await expect(apply).toBeDisabled();
    await page.getByLabel('I understand this changes the local desired configuration.').check();
    await expect(apply).toBeEnabled();
    await expect(page.getByText('Core-derived guidance · not authority')).toBeVisible();

    expect(fs.readFileSync(source, 'utf8')).toBe(sourceBefore);
    expect(fs.readFileSync(fixtureLock, 'utf8')).toBe(fixtureLockBefore);
    expect(workspaceFingerprint(root)).toBe(workspaceBefore);
    expect(fs.existsSync(path.join(root, '.soter/state/configuration-change-plans'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.soter/state/configuration-locks/meeting-intake.json'))).toBe(false);
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
  const developmentInstructions = fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'));
  const developmentConfig = fs.readFileSync(path.join(repositoryRoot, '.codex/config.toml'));
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
    expect(fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'))).toEqual(developmentInstructions);
    expect(fs.readFileSync(path.join(repositoryRoot, '.codex/config.toml'))).toEqual(developmentConfig);
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
  try {
    const source = path.join(root, 'soter/capabilities/crm.records.read.json');
    const target = path.join(root, 'soter/capabilities/studio.test.read.json');
    const capability = JSON.parse(fs.readFileSync(source, 'utf8'));
    capability.id = 'studio.test.read';
    capability.purpose = 'Contained inspection capability used only to prove watcher invalidation.';
    fs.writeFileSync(target, JSON.stringify(capability, null, 2) + '\n');
    await expect(page.locator('.catalog-panel').getByText('Studio Test Read')).toBeVisible({ timeout: 10_000 });
    const privateCalls = path.join(root, '.soter/state/host-calls');
    fs.mkdirSync(privateCalls, { recursive: true });
    fs.writeFileSync(path.join(privateCalls, 'malformed.json'), '{not-json\n');
    await expect(page.getByText('SOTER_INSPECTION_RUNTIME_JSON_INVALID')).toBeAttached({ timeout: 10_000 });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function expectAccessible(page: Page) {
  const accessibility = await page.evaluate(() => (window as unknown as { axe: { run: (document: Document, options: object) => Promise<{ violations: unknown[] }> } }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
  expect(accessibility.violations).toEqual([]);
}
