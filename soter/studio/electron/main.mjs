import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  inspectEmailTriageProposalMaterial,
  loadEmailTriageProposal
} from '../../automations/email-triage/proposal.mjs';
import {
  inspectProjectCaptureProposalMaterial,
  loadProjectCaptureProposal
} from '../../automations/project-capture/proposal.mjs';
import {
  inspectProjectPageReconciliationProposalMaterial,
  loadProjectPageReconciliationProposal
} from '../../automations/project-page-reconciliation/proposal.mjs';
import { inspectWorkspace } from '../../core/inspection.mjs';
import { previewConfiguration } from '../../core/configuration-preview.mjs';
import {
  beginConfigurationChangeRequest,
  confirmConfigurationChangeRequest,
  describeConfigurationOnboarding,
  executeConfigurationChange,
  inspectConfigurationChange,
  prepareConfigurationOnboarding,
  prepareConfigurationChangeExecution,
  recoverConfigurationChange,
  resumeConfigurationChangeExecution
} from '../../core/configuration-transactions.mjs';
import {
  beginHostRealizationRequest,
  confirmHostRealizationRequest,
  executeHostRealization,
  inspectHostRealization,
  prepareHostRealization,
  prepareHostRealizationExecution,
  recoverHostRealization
} from '../../core/host-realizations.mjs';
import {
  beginPackInstallRequest,
  confirmPackInstallRequest,
  executePackInstall,
  inspectPackInstall,
  preparePackInstall,
  preparePackInstallExecution,
  recoverPackInstall
} from '../../core/pack-installs.mjs';
import { fingerprintJson, readJson, repoRelativePath } from '../../core/lib/canonical-json.mjs';
import {
  beginProposalConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest
} from '../../core/operator-authority.mjs';
import { inspectConnectedApprovalReviewMaterial } from '../../core/connected-approval-review.mjs';
import { inspectConnectedOperatorActivity } from '../../core/operator-inspection.mjs';
import { createProposalConnectedBatch } from '../../core/proposal-connected-batches.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import {
  createReviewOnlyCandidateSelection,
  inspectReviewOnlyCandidateSelectionMaterial
} from '../../core/review-only-candidate-selections.mjs';
import {
  createReviewOnlyCandidatePreview,
  inspectReviewOnlyCandidatePreview
} from '../../core/review-only-candidate-previews.mjs';
import {
  prepareDurableConnectedTransactionExecution,
  prepareDurableConnectedTransactionReconciliation
} from '../../core/service.mjs';
import {
  hasPrivateConfigurationState,
  privateConfigurationStatePath,
  readPrivateConfigurationState
} from '../../core/private-configurations.mjs';
import {
  activeConfigurationLockStatePath,
  hasActiveConfigurationLockState,
  readActiveConfigurationLockState
} from '../../core/runtime-state.mjs';
import { fingerprintLock, lockMatchesResolution } from '../../core/resolve.mjs';
import { inspectBundle, verifyPackRelease } from '../../kernel/distribution.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packagedRendererRoot = path.resolve(moduleDirectory, '../../../dist/soter-studio');
const developmentUrl = process.env.SOTER_STUDIO_DEV_URL || null;
const productionCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
const preparedReviewErrorCodes = new Set([
  'PREPARED_REVIEW_MATERIAL_MISSING',
  'PREPARED_REVIEW_MATERIAL_MALFORMED',
  'PREPARED_REVIEW_MATERIAL_TAMPERED',
  'PREPARED_REVIEW_MATERIAL_BINDING_INVALID',
  'PREPARED_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
  'PREPARED_REVIEW_MATERIAL_MISMATCH',
  'PREPARED_REVIEW_MATERIAL_WRITE_FAILED'
]);
const preparedDerivedReviewErrorCodes = new Set([
  'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING',
  'PREPARED_DERIVED_REVIEW_MATERIAL_MALFORMED',
  'PREPARED_DERIVED_REVIEW_MATERIAL_TAMPERED',
  'PREPARED_DERIVED_REVIEW_MATERIAL_BINDING_INVALID',
  'PREPARED_DERIVED_REVIEW_MATERIAL_CREDENTIAL_REJECTED',
  'PREPARED_DERIVED_REVIEW_MATERIAL_MISMATCH',
  'PREPARED_DERIVED_REVIEW_MATERIAL_WRITE_FAILED'
]);
const connectedApprovalReviewErrorCodes = new Set([
  'CONNECTED_APPROVAL_REVIEW_MATERIAL_MISSING',
  'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED',
  'CONNECTED_APPROVAL_REVIEW_MATERIAL_TAMPERED',
  'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID',
  'CONNECTED_APPROVAL_REVIEW_MATERIAL_CREDENTIAL_REJECTED'
]);
const reviewOnlyCandidateSelectionErrorCodes = new Set([
  'REVIEW_ONLY_CANDIDATE_SELECTION_MISSING',
  'REVIEW_ONLY_CANDIDATE_SELECTION_MALFORMED',
  'REVIEW_ONLY_CANDIDATE_SELECTION_TAMPERED',
  'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
  'REVIEW_ONLY_CANDIDATE_SELECTION_INVALID',
  'REVIEW_ONLY_CANDIDATE_SELECTION_STALE',
  'REVIEW_ONLY_CANDIDATE_SELECTION_WRITE_FAILED'
]);
const reviewOnlyCandidateSelectionMaterialErrorCodes = new Set([
  ...reviewOnlyCandidateSelectionErrorCodes,
  'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_MALFORMED',
  'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_TAMPERED',
  'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
  'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_CREDENTIAL_REJECTED'
]);
const reviewOnlyCandidatePreviewErrorCodes = new Set([
  'REVIEW_ONLY_CANDIDATE_PREVIEW_BINDING_INVALID',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_COMPILER_INVALID',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_CREDENTIAL_REJECTED',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_LOCK_INVALID',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_MALFORMED',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_MISSING',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_SOURCE_INVALID',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_STALE',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_TAMPERED',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_INVALID',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_VERIFICATION_RECEIPT_REQUIRED',
  'REVIEW_ONLY_CANDIDATE_PREVIEW_WRITE_FAILED'
]);
const automationProposalErrorCodes = new Set([
  'AUTOMATION_PROPOSAL_MISSING',
  'AUTOMATION_PROPOSAL_MALFORMED',
  'AUTOMATION_PROPOSAL_TAMPERED',
  'AUTOMATION_PROPOSAL_BINDING_INVALID',
  'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
  'AUTOMATION_PROPOSAL_STALE',
  'AUTOMATION_PROPOSAL_CREDENTIAL_REJECTED',
  'AUTOMATION_PROPOSAL_STATE_INCOMPLETE',
  'AUTOMATION_PROPOSAL_WRITE_FAILED'
]);
const automationProposalMaterialErrorCodes = new Set([
  'AUTOMATION_PROPOSAL_MATERIAL_MALFORMED',
  'AUTOMATION_PROPOSAL_MATERIAL_TAMPERED',
  'AUTOMATION_PROPOSAL_MATERIAL_BINDING_INVALID',
  'AUTOMATION_PROPOSAL_MATERIAL_CREDENTIAL_REJECTED'
]);
const proposalConnectedBatchErrorCodes = new Set([
  'PROPOSAL_CONNECTED_BATCH_SELECTION_INVALID',
  'PROPOSAL_CONNECTED_BATCH_BINDING_INVALID',
  'PROPOSAL_CONNECTED_BATCH_CREDENTIAL_REJECTED',
  'PROPOSAL_CONNECTED_BATCH_MALFORMED',
  'PROPOSAL_CONNECTED_BATCH_STALE',
  'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE',
  'PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE'
]);
const connectedApprovalActionErrorCodes = new Set([
  ...proposalConnectedBatchErrorCodes
]);
const connectedTransactionStartErrorCodes = new Set([
  ...proposalConnectedBatchErrorCodes,
  'CONNECTED_TRANSACTION_PREFLIGHT_FAILED'
]);
const connectedActionMessages = new Map([
  [
    'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE',
    'The exact connected proposal context is stale. Rebuild and review a current proposal before requesting, confirming, or starting.'
  ],
  [
    'CONNECTED_TRANSACTION_PREFLIGHT_FAILED',
    'The exact connected transaction could not prepare its provider call. No approval was consumed and no checkpoint or provider effect was created.'
  ],
  [
    'PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE',
    'The selected proposal actions do not have one exact connected write and verification provider.'
  ]
]);
const configurationChangeCode = /^CONFIGURATION_[A-Z0-9_]+$/;
const maximumConfigurationOnboardingSlots = 500;
const hostRealizationCode = /^HOST_REALIZATION_[A-Z0-9_]+$/;
const distributionCode = /^(PACK_RELEASE|BUNDLE|DISTRIBUTION)_[A-Z0-9_]+$/;
const packInstallCode = /^PACK_INSTALL_[A-Z0-9_]+$/;
const stableReasonCode = /^[A-Z][A-Z0-9_]{0,127}$/;
const automationProposalAdapters = new Map([
  [
    'email-triage',
    {
      automationId: 'automation.email-triage',
      idNamespace: 'email-triage',
      reviewLabel: 'Email triage',
      load: loadEmailTriageProposal,
      inspectMaterial: inspectEmailTriageProposalMaterial
    }
  ],
  [
    'project-capture',
    {
      automationId: 'automation.project-capture',
      idNamespace: 'project-capture',
      reviewLabel: 'Project Capture',
      load: loadProjectCaptureProposal,
      inspectMaterial: inspectProjectCaptureProposalMaterial
    }
  ],
  [
    'project-page-reconciliation',
    {
      automationId: 'automation.project-page-reconciliation',
      idNamespace: 'project-page-reconciliation',
      reviewLabel: 'Project Page Reconciliation',
      load: loadProjectPageReconciliationProposal,
      inspectMaterial: inspectProjectPageReconciliationProposalMaterial
    }
  ]
]);

function sanitizedConnectedActionError(error, {
  allowedCodes,
  fallbackCode,
  fallbackMessage
}) {
  const exactCode = typeof error?.code === 'string' && allowedCodes.has(error.code);
  const code = exactCode ? error.code : fallbackCode;
  const reasonCode = exactCode
    && typeof error?.reasonCode === 'string'
    && stableReasonCode.test(error.reasonCode)
    ? error.reasonCode
    : null;
  return {
    code,
    ...(reasonCode ? { reasonCode } : {}),
    message: connectedActionMessages.get(code) || fallbackMessage
  };
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'soter-studio',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false
  }
}]);

function workspaceRoot() {
  const requested = process.env.SOTER_ROOT
    ? path.resolve(process.env.SOTER_ROOT)
    : path.resolve(app.getAppPath());
  if (!fs.existsSync(path.join(requested, 'soter'))
    || !fs.existsSync(path.join(requested, 'package.json'))) {
    throw new Error('Soter Studio launch root is not a Soter workspace: ' + requested);
  }
  return requested;
}

function senderAllowed(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (developmentUrl) {
    return senderUrl === developmentUrl + '/'
      || senderUrl.startsWith(developmentUrl + '/#');
  }
  return senderUrl === 'soter-studio://app/'
    || senderUrl === 'soter-studio://app/index.html'
    || senderUrl.startsWith('soter-studio://app/index.html#');
}

function assertSender(event) {
  if (!senderAllowed(event)) throw new Error('Rejected workspace inspection from an untrusted renderer.');
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function configurationChangeFailure(error, message) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' && configurationChangeCode.test(error.code)
        ? error.code
        : 'CONFIGURATION_ADAPTER_UNAVAILABLE',
      message
    }
  };
}

function hostRealizationFailure(error, message) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' && hostRealizationCode.test(error.code)
        ? error.code
        : 'HOST_REALIZATION_ADAPTER_UNAVAILABLE',
      message
    }
  };
}

function distributionFailure(error, artifact) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' && distributionCode.test(error.code)
        ? error.code
        : 'DISTRIBUTION_ADAPTER_UNAVAILABLE',
      message: artifact === 'release'
        ? 'The selected local pack release could not be verified.'
        : 'The selected local bundle could not be inspected.'
    }
  };
}

function distributionCancelled(artifact) {
  return {
    ok: false,
    error: {
      code: 'DISTRIBUTION_SELECTION_CANCELLED',
      message: artifact === 'release'
        ? 'No local pack release was selected.'
        : 'No local bundle was selected.'
    }
  };
}

function packInstallFailure(error, message = 'The exact local pack install operation is unavailable.') {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' && packInstallCode.test(error.code)
        ? error.code
        : 'PACK_INSTALL_ADAPTER_UNAVAILABLE',
      message
    }
  };
}

function registerRendererProtocol() {
  protocol.handle('soter-studio', async (request) => {
    const requested = new URL(request.url);
    const relative = requested.pathname === '/' ? 'index.html' : decodeURIComponent(requested.pathname.slice(1));
    const target = path.resolve(packagedRendererRoot, relative);
    if (target !== packagedRendererRoot && !target.startsWith(packagedRendererRoot + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', productionCsp);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  });
}

function installSecurityBoundaries(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = developmentUrl
      ? url === developmentUrl + '/' || url.startsWith(developmentUrl + '/#')
      : url === 'soter-studio://app/'
        || url === 'soter-studio://app/index.html'
        || url.startsWith('soter-studio://app/index.html#');
    if (!allowed) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function watchWorkspace(root, window) {
  const watched = [
    'soter/contracts',
    'soter/packs',
    'soter/capabilities',
    'soter/configurations',
    'soter/hosts',
    'soter/providers',
    'soter/scenarios',
    'soter/fixtures'
  ];
  const watchers = [];
  const watchedPaths = new Set();
  let timeout = null;
  const invalidate = () => {
    snapshotPromise = null;
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.send('workspace:invalidated');
    }, 160);
  };
  const attach = (directory, listener = invalidate) => {
    if (!fs.existsSync(directory) || watchedPaths.has(directory)) return;
    try {
      watchers.push(fs.watch(directory, { recursive: true }, listener));
    } catch {
      watchers.push(fs.watch(directory, listener));
    }
    watchedPaths.add(directory);
  };
  for (const relative of watched) attach(path.join(root, relative));

  const attachPrivateState = () => {
    const privateRoot = path.join(root, '.soter');
    if (!fs.existsSync(privateRoot)) return;
    attach(privateRoot, (_event, filename) => {
      const relative = String(filename || '').split(path.sep).join('/');
      if (relative === 'state' || relative.startsWith('state/')) invalidate();
    });
  };
  attachPrivateState();
  attach(root, (_event, filename) => {
    if (String(filename || '') !== '.soter') return;
    attachPrivateState();
    invalidate();
  });

  return {
    invalidate,
    close: () => {
      clearTimeout(timeout);
      watchers.forEach((watcher) => watcher.close());
    }
  };
}

let snapshotPromise = null;

function loadSnapshot(root, refresh = false) {
  if (refresh) snapshotPromise = null;
  if (!snapshotPromise) {
    snapshotPromise = Promise.resolve().then(() => inspectWorkspace({ root }));
  }
  return snapshotPromise;
}

function automationProposalLock(root, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== 'configurationName,lockFingerprint,proposalId'
    || typeof request.proposalId !== 'string'
    || typeof request.configurationName !== 'string'
    || typeof request.lockFingerprint !== 'string') {
    throw new TypeError('Automation proposal inspection requires one exact proposal and configuration lock reference.');
  }
  if (!hasPrivateConfigurationState(root, request.configurationName)
    || !hasActiveConfigurationLockState(root, request.configurationName)) {
    const error = new Error('Automation proposal configuration lock binding is unavailable.');
    error.code = 'AUTOMATION_PROPOSAL_BINDING_INVALID';
    throw error;
  }
  const desired = readPrivateConfigurationState(root, request.configurationName);
  const active = readActiveConfigurationLockState(root, request.configurationName);
  const lock = active.lock;
  const expectedConfigurationPath = repoRelativePath(
    root,
    privateConfigurationStatePath(root, request.configurationName)
  );
  if (desired.path !== expectedConfigurationPath
    || lock.$contract !== 'soter://contracts/lock/v1'
    || lock.configuration.name !== request.configurationName
    || lock.configuration.path !== expectedConfigurationPath
    || fingerprintLock(lock) !== request.lockFingerprint) {
    const error = new Error('Automation proposal configuration lock binding is unavailable.');
    error.code = 'AUTOMATION_PROPOSAL_BINDING_INVALID';
    throw error;
  }
  const applicability = lockMatchesResolution({
    root,
    lock,
    configPath: expectedConfigurationPath,
    host: lock.host.id
  });
  if (!applicability.matches) {
    const error = new Error('Automation proposal configuration lock is stale.');
    error.code = 'AUTOMATION_PROPOSAL_STALE';
    throw error;
  }
  const adapter = automationProposalAdapters.get(request.configurationName);
  if (!adapter || !lock.packs.some((pack) => pack.id === adapter.automationId)) {
    const error = new Error('Automation proposal route is not selected by this exact configuration lock.');
    error.code = 'AUTOMATION_PROPOSAL_BINDING_INVALID';
    throw error;
  }
  return {
    adapter,
    exact: {
      proposalId: request.proposalId,
      lockPath: repoRelativePath(
        root,
        activeConfigurationLockStatePath(root, request.configurationName)
      ),
      expectedHost: lock.host.id
    }
  };
}

async function createWindow() {
  const root = workspaceRoot();
  const packInstallTargets = new Map();
  const window = new BrowserWindow({
    title: 'Soter Studio',
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#F3F6F6',
    show: false,
    webPreferences: {
      preload: path.join(moduleDirectory, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  installSecurityBoundaries(window);
  const workspaceWatcher = watchWorkspace(root, window);
  window.on('closed', workspaceWatcher.close);
  window.once('ready-to-show', () => window.show());

  ipcMain.handle('workspace:get', async (event) => {
    assertSender(event);
    return loadSnapshot(root);
  });
  ipcMain.handle('workspace:refresh', async (event) => {
    assertSender(event);
    return loadSnapshot(root, true);
  });
  ipcMain.handle('distribution:inspect-release', async (event) => {
    assertSender(event);
    try {
      const selection = await dialog.showOpenDialog(window, {
        title: 'Inspect local Soter pack release',
        buttonLabel: 'Inspect release',
        properties: ['openFile'],
        filters: [{ name: 'Soter canonical JSON capsules', extensions: ['json'] }]
      });
      if (selection.canceled || selection.filePaths.length !== 1) return distributionCancelled('release');
      return {
        ok: true,
        inspection: verifyPackRelease({
          capsulePath: selection.filePaths[0],
          contractRoot: root
        })
      };
    } catch (error) {
      return distributionFailure(error, 'release');
    }
  });
  ipcMain.handle('distribution:inspect-bundle', async (event) => {
    assertSender(event);
    try {
      const bundleSelection = await dialog.showOpenDialog(window, {
        title: 'Inspect local Soter bundle',
        buttonLabel: 'Choose bundle',
        properties: ['openFile'],
        filters: [{ name: 'Soter canonical JSON bundles', extensions: ['json'] }]
      });
      if (bundleSelection.canceled || bundleSelection.filePaths.length !== 1) return distributionCancelled('bundle');
      const catalogSelection = await dialog.showOpenDialog(window, {
        title: 'Select the local pack release catalog',
        message: 'Select zero or more local capsules. Cancel to inspect this bundle against an empty catalog.',
        buttonLabel: 'Use selected releases',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Soter canonical JSON capsules', extensions: ['json'] }]
      });
      return {
        ok: true,
        inspection: inspectBundle({
          bundlePath: bundleSelection.filePaths[0],
          releasePaths: catalogSelection.canceled ? [] : catalogSelection.filePaths,
          contractRoot: root
        })
      };
    } catch (error) {
      return distributionFailure(error, 'bundle');
    }
  });
  const bindPackInstallTarget = (targetRoot, inspection) => {
    for (const reference of [
      inspection.plan?.id,
      inspection.request?.id,
      inspection.confirmation?.id,
      inspection.consumption?.id,
      inspection.checkpoint?.id
    ]) {
      if (reference) packInstallTargets.set(reference, targetRoot);
    }
    return inspection;
  };
  const knownPackInstallTarget = (request) => {
    for (const value of Object.values(request || {})) {
      if (typeof value === 'string' && packInstallTargets.has(value)) return packInstallTargets.get(value);
    }
    return null;
  };
  ipcMain.handle('pack-install:plan', async (event) => {
    assertSender(event);
    try {
      const targetSelection = await dialog.showOpenDialog(window, {
        title: 'Select the private local pack install target',
        buttonLabel: 'Use this target',
        properties: ['openDirectory']
      });
      if (targetSelection.canceled || targetSelection.filePaths.length !== 1) {
        return packInstallFailure(
          { code: 'PACK_INSTALL_SELECTION_CANCELLED' },
          'No local pack install target was selected.'
        );
      }
      const releaseSelection = await dialog.showOpenDialog(window, {
        title: 'Select exact local Soter pack releases',
        buttonLabel: 'Prepare exact install plan',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Soter canonical JSON capsules', extensions: ['json'] }]
      });
      if (releaseSelection.canceled || releaseSelection.filePaths.length < 1) {
        return packInstallFailure(
          { code: 'PACK_INSTALL_SELECTION_CANCELLED' },
          'No local pack release was selected.'
        );
      }
      const at = new Date().toISOString();
      const inspection = preparePackInstall({
        sourceRoot: root,
        targetRoot: targetSelection.filePaths[0],
        capsulePaths: releaseSelection.filePaths,
        baseContract: '1.0.0',
        planId: `pack-install-plan.${randomUUID()}`,
        createdAt: at,
        validUntil: new Date(Date.parse(at) + 15 * 60 * 1000).toISOString()
      });
      return {
        ok: true,
        inspection: bindPackInstallTarget(targetSelection.filePaths[0], inspection)
      };
    } catch (error) {
      return packInstallFailure(error, 'The exact private local pack install plan is unavailable.');
    }
  });
  ipcMain.handle('pack-install:request', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['planId']) || typeof request.planId !== 'string') {
        throw new TypeError('Pack install request requires one exact plan id.');
      }
      const targetRoot = knownPackInstallTarget(request);
      if (!targetRoot) throw new Error('Pack install target is unavailable in this private Studio session.');
      const at = new Date().toISOString();
      const inspection = beginPackInstallRequest({
        sourceRoot: root,
        targetRoot,
        planId: request.planId,
        requestId: `pack-install-request.${randomUUID()}`,
        reason: 'Review and confirm this exact local pack install plan.',
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + 5 * 60 * 1000).toISOString()
      });
      return { ok: true, inspection: bindPackInstallTarget(targetRoot, inspection) };
    } catch (error) {
      return packInstallFailure(error);
    }
  });
  ipcMain.handle('pack-install:confirm', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['requestId', 'confirmed'])
        || typeof request.requestId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Pack install confirmation requires one acknowledged exact request id.');
      }
      const targetRoot = knownPackInstallTarget(request);
      if (!targetRoot) throw new Error('Pack install target is unavailable in this private Studio session.');
      const inspection = confirmPackInstallRequest({
        sourceRoot: root,
        targetRoot,
        requestId: request.requestId,
        confirmationId: `pack-install-confirmation.${randomUUID()}`,
        actor: 'studio.local-operator',
        reason: 'Start only this exact reviewed local pack install plan.',
        confirmedAt: new Date().toISOString()
      });
      return { ok: true, inspection: bindPackInstallTarget(targetRoot, inspection) };
    } catch (error) {
      return packInstallFailure(error);
    }
  });
  ipcMain.handle('pack-install:start', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['confirmationId']) || typeof request.confirmationId !== 'string') {
        throw new TypeError('Pack install start requires one exact confirmation id.');
      }
      const targetRoot = knownPackInstallTarget(request);
      if (!targetRoot) throw new Error('Pack install target is unavailable in this private Studio session.');
      const inspection = preparePackInstallExecution({
        sourceRoot: root,
        targetRoot,
        confirmationId: request.confirmationId,
        checkpointId: `checkpoint.pack-install.${randomUUID()}`,
        at: new Date().toISOString()
      });
      return { ok: true, inspection: bindPackInstallTarget(targetRoot, inspection) };
    } catch (error) {
      return packInstallFailure(error);
    }
  });
  ipcMain.handle('pack-install:execute', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['checkpointId', 'confirmed'])
        || typeof request.checkpointId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Pack install execution requires one acknowledged exact checkpoint id.');
      }
      const targetRoot = knownPackInstallTarget(request);
      if (!targetRoot) throw new Error('Pack install target is unavailable in this private Studio session.');
      const inspection = executePackInstall({
        sourceRoot: root,
        targetRoot,
        checkpointId: request.checkpointId,
        at: new Date().toISOString()
      });
      snapshotPromise = null;
      return { ok: true, inspection: bindPackInstallTarget(targetRoot, inspection) };
    } catch (error) {
      return packInstallFailure(error, 'The exact local pack install checkpoint stopped safely.');
    }
  });
  ipcMain.handle('pack-install:recover', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['checkpointId', 'confirmed'])
        || typeof request.checkpointId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Pack install recovery requires one acknowledged exact checkpoint id.');
      }
      const targetRoot = knownPackInstallTarget(request);
      if (!targetRoot) throw new Error('Pack install target is unavailable in this private Studio session.');
      const inspection = recoverPackInstall({
        sourceRoot: root,
        targetRoot,
        checkpointId: request.checkpointId,
        at: new Date().toISOString()
      });
      snapshotPromise = null;
      return { ok: true, inspection: bindPackInstallTarget(targetRoot, inspection) };
    } catch (error) {
      return packInstallFailure(error, 'The exact local pack install checkpoint requires attention.');
    }
  });
  ipcMain.handle('pack-install:inspect', async (event, request) => {
    assertSender(event);
    try {
      const allowed = new Set(['planId', 'requestId', 'confirmationId', 'consumptionId', 'checkpointId']);
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || !Object.keys(request).length
        || Object.keys(request).some((key) => !allowed.has(key))
        || Object.values(request).some((value) => value !== null && typeof value !== 'string')) {
        throw new TypeError('Pack install inspection requires exact transaction identifiers only.');
      }
      let targetRoot = knownPackInstallTarget(request);
      if (!targetRoot) {
        const selection = await dialog.showOpenDialog(window, {
          title: 'Locate the private local pack install target',
          buttonLabel: 'Inspect this target',
          properties: ['openDirectory']
        });
        if (selection.canceled || selection.filePaths.length !== 1) {
          return packInstallFailure(
            { code: 'PACK_INSTALL_SELECTION_CANCELLED' },
            'No local pack install target was selected.'
          );
        }
        [targetRoot] = selection.filePaths;
      }
      const inspection = inspectPackInstall({
        sourceRoot: root,
        targetRoot,
        ...request,
        at: new Date().toISOString()
      });
      return { ok: true, inspection: bindPackInstallTarget(targetRoot, inspection) };
    } catch (error) {
      return packInstallFailure(error, 'The exact local pack install inspection is unavailable.');
    }
  });
  ipcMain.handle('configuration:preview', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || !['tracked-contained', 'private-active'].includes(request.configurationBasis)) {
      throw new TypeError('Configuration preview request must be an object.');
    }
    return previewConfiguration({
      root,
      name: request.name,
      configurationBasis: request.configurationBasis,
      draft: request.draft
    });
  });
  ipcMain.handle('configuration:onboarding-describe', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['name']) || typeof request.name !== 'string') {
        throw new TypeError('Configuration onboarding description requires one configuration name.');
      }
      return {
        ok: true,
        description: describeConfigurationOnboarding({ root, name: request.name })
      };
    } catch (error) {
      return configurationChangeFailure(
        error,
        'The blank typed private onboarding description is unavailable.'
      );
    }
  });
  ipcMain.handle('configuration:onboarding-plan', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['name', 'descriptionFingerprint', 'slots'])
        || typeof request.name !== 'string'
        || typeof request.descriptionFingerprint !== 'string'
        || !Array.isArray(request.slots)
        || request.slots.length > maximumConfigurationOnboardingSlots) {
        throw new TypeError('Configuration onboarding requires one exact typed private input.');
      }
      const unsignedInput = {
        $contract: 'soter://contracts/configuration-onboarding-input/v1',
        contractVersion: '1.0.0',
        configuration: {
          name: request.name,
          descriptionFingerprint: request.descriptionFingerprint
        },
        slots: request.slots
      };
      const at = new Date().toISOString();
      const inspection = prepareConfigurationOnboarding({
        root,
        name: request.name,
        input: { ...unsignedInput, inputFingerprint: fingerprintJson(unsignedInput) },
        id: `configuration-change-plan.${request.name}.${randomUUID()}`,
        createdAt: at
      });
      workspaceWatcher.invalidate();
      return { ok: true, inspection };
    } catch (error) {
      return configurationChangeFailure(error, 'The exact private onboarding plan is unavailable.');
    }
  });
  ipcMain.handle('configuration:change-request', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['planId', 'reason'])
        || typeof request.planId !== 'string'
        || typeof request.reason !== 'string') {
        throw new TypeError('Configuration confirmation request requires one exact plan and reason.');
      }
      const created = new Date();
      const result = beginConfigurationChangeRequest({
        root,
        planId: request.planId,
        id: `configuration-change-request.${randomUUID()}`,
        reason: request.reason,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + 10 * 60 * 1000).toISOString()
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConfigurationChange({
          root,
          planId: result.request.plan.id,
          requestId: result.request.id,
          at: created.toISOString()
        })
      };
    } catch (error) {
      return configurationChangeFailure(error, 'The exact configuration confirmation request is unavailable.');
    }
  });
  ipcMain.handle('configuration:change-confirm', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['requestId', 'confirmed'])
        || typeof request.requestId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Configuration confirmation requires an explicit decision and exact request id.');
      }
      const confirmedAt = new Date().toISOString();
      const result = confirmConfigurationChangeRequest({
        root,
        requestId: request.requestId,
        id: `configuration-change-confirmation.${randomUUID()}`,
        actor: { type: 'local-operator', id: 'local-studio-operator' },
        reason: 'Confirmed in Soter Studio after exact-scope review.',
        confirmedAt
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConfigurationChange({
          root,
          planId: result.confirmation.plan.id,
          requestId: result.confirmation.request.id,
          confirmationId: result.confirmation.id,
          at: confirmedAt
        })
      };
    } catch (error) {
      return configurationChangeFailure(error, 'The exact local configuration confirmation is unavailable.');
    }
  });
  ipcMain.handle('configuration:change-start', async (event, request) => {
    assertSender(event);
    try {
      const freshStart = exactObject(request, ['confirmationId']);
      const resumedStart = exactObject(request, ['confirmationId', 'checkpointId']);
      if ((!freshStart && !resumedStart)
        || typeof request.confirmationId !== 'string'
        || (resumedStart && typeof request.checkpointId !== 'string')) {
        throw new TypeError('Configuration start requires one exact confirmation id and, only for re-entry, one exact checkpoint id.');
      }
      const at = new Date().toISOString();
      const result = resumedStart
        ? resumeConfigurationChangeExecution({
            root,
            confirmationId: request.confirmationId,
            checkpointId: request.checkpointId,
            at
          })
        : prepareConfigurationChangeExecution({
            root,
            confirmationId: request.confirmationId,
            checkpointId: `checkpoint.configuration.${randomUUID()}`,
            at
          });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConfigurationChange({
          root,
          planId: result.checkpoint.plan.id,
          requestId: result.checkpoint.request.id,
          confirmationId: result.checkpoint.confirmation.id,
          consumptionId: result.consumption.id,
          checkpointId: result.checkpoint.id,
          at
        })
      };
    } catch (error) {
      return configurationChangeFailure(error, 'The one-time configuration start is unavailable.');
    }
  });
  ipcMain.handle('configuration:change-execute', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['checkpointId', 'confirmed'])
        || typeof request.checkpointId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Configuration execution requires explicit acknowledgement and one exact checkpoint id.');
      }
      const at = new Date().toISOString();
      const checkpoint = executeConfigurationChange({ root, checkpointId: request.checkpointId, at });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConfigurationChange({
          root,
          planId: checkpoint.plan.id,
          requestId: checkpoint.request.id,
          confirmationId: checkpoint.confirmation.id,
          consumptionId: checkpoint.consumption.id,
          checkpointId: checkpoint.id,
          at
        })
      };
    } catch (error) {
      return configurationChangeFailure(error, 'The exact local configuration apply is unavailable.');
    }
  });
  ipcMain.handle('configuration:change-recover', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['checkpointId', 'confirmed'])
        || typeof request.checkpointId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Configuration recovery requires explicit acknowledgement and one exact checkpoint id.');
      }
      const at = new Date().toISOString();
      const checkpoint = recoverConfigurationChange({ root, checkpointId: request.checkpointId, at });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConfigurationChange({
          root,
          planId: checkpoint.plan.id,
          requestId: checkpoint.request.id,
          confirmationId: checkpoint.confirmation.id,
          consumptionId: checkpoint.consumption.id,
          checkpointId: checkpoint.id,
          at
        })
      };
    } catch (error) {
      return configurationChangeFailure(error, 'The exact local configuration checkpoint could not be recovered.');
    }
  });
  ipcMain.handle('configuration:change-inspect', async (event, request) => {
    assertSender(event);
    try {
      const allowed = new Set(['planId', 'requestId', 'confirmationId', 'checkpointId']);
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.planId !== 'string'
        || Object.keys(request).some((key) => !allowed.has(key))
        || ['requestId', 'confirmationId', 'checkpointId'].some((key) => request[key] !== undefined && typeof request[key] !== 'string')) {
        throw new TypeError('Configuration inspection requires one exact plan and optional bound references.');
      }
      return {
        ok: true,
        inspection: inspectConfigurationChange({
          root,
          planId: request.planId,
          requestId: request.requestId || null,
          confirmationId: request.confirmationId || null,
          checkpointId: request.checkpointId || null,
          at: new Date().toISOString()
        })
      };
    } catch (error) {
      return configurationChangeFailure(error, 'The exact configuration transaction inspection is unavailable.');
    }
  });
  ipcMain.handle('host:realization-plan', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['configurationName']) || typeof request.configurationName !== 'string') {
        throw new TypeError('Host realization planning requires one exact configuration name.');
      }
      const created = new Date();
      const createdAt = created.toISOString();
      const result = prepareHostRealization({
        root,
        configurationName: request.configurationName,
        id: `host-realization-plan.${request.configurationName}.${randomUUID()}`,
        createdAt,
        validUntil: new Date(created.getTime() + 20 * 60 * 1000).toISOString()
      });
      workspaceWatcher.invalidate();
      return { ok: true, inspection: inspectHostRealization({ root, planId: result.plan.id, at: createdAt }) };
    } catch (error) {
      return hostRealizationFailure(error, 'The exact private host realization plan is unavailable.');
    }
  });
  ipcMain.handle('host:realization-request', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['planId']) || typeof request.planId !== 'string') {
        throw new TypeError('Host realization request requires one exact plan id.');
      }
      const created = new Date();
      const createdAt = created.toISOString();
      const planInspection = inspectHostRealization({ root, planId: request.planId, at: createdAt });
      const desiredExpiry = created.getTime() + 8 * 60 * 1000;
      const expiresAt = new Date(Math.min(desiredExpiry, Date.parse(planInspection.plan.validUntil))).toISOString();
      const result = beginHostRealizationRequest({
        root,
        planId: request.planId,
        id: `host-realization-request.${randomUUID()}`,
        reason: 'Review this exact fingerprint-only host output scope.',
        createdAt,
        expiresAt
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectHostRealization({ root, planId: request.planId, requestId: result.request.id, at: createdAt })
      };
    } catch (error) {
      return hostRealizationFailure(error, 'The exact host realization confirmation request is unavailable.');
    }
  });
  ipcMain.handle('host:realization-confirm', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['requestId', 'confirmed'])
        || typeof request.requestId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Host realization confirmation requires one exact request and explicit decision.');
      }
      const confirmedAt = new Date().toISOString();
      const result = confirmHostRealizationRequest({
        root,
        requestId: request.requestId,
        id: `host-realization-confirmation.${randomUUID()}`,
        actor: { type: 'local-operator', id: 'local-studio-operator' },
        reason: 'Confirmed in Soter Studio after exact host output scope review.',
        confirmedAt
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectHostRealization({
          root,
          planId: result.confirmation.plan.id,
          requestId: result.confirmation.request.id,
          confirmationId: result.confirmation.id,
          at: confirmedAt
        })
      };
    } catch (error) {
      return hostRealizationFailure(error, 'The exact local host realization confirmation is unavailable.');
    }
  });
  ipcMain.handle('host:realization-start', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['confirmationId']) || typeof request.confirmationId !== 'string') {
        throw new TypeError('Host realization start requires one exact confirmation id.');
      }
      const at = new Date().toISOString();
      const result = prepareHostRealizationExecution({
        root,
        confirmationId: request.confirmationId,
        checkpointId: `checkpoint.host-realization.${randomUUID()}`,
        at
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectHostRealization({
          root,
          planId: result.checkpoint.plan.id,
          requestId: result.checkpoint.request.id,
          confirmationId: result.checkpoint.confirmation.id,
          consumptionId: result.consumption.id,
          checkpointId: result.checkpoint.id,
          at
        })
      };
    } catch (error) {
      return hostRealizationFailure(error, 'The one-time host realization start is unavailable.');
    }
  });
  ipcMain.handle('host:realization-execute', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['checkpointId', 'confirmed'])
        || typeof request.checkpointId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Host realization execution requires one exact checkpoint and explicit acknowledgement.');
      }
      const at = new Date().toISOString();
      const checkpoint = executeHostRealization({ root, checkpointId: request.checkpointId, at });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectHostRealization({
          root,
          planId: checkpoint.plan.id,
          requestId: checkpoint.request.id,
          confirmationId: checkpoint.confirmation.id,
          consumptionId: checkpoint.consumption.id,
          checkpointId: checkpoint.id,
          at
        })
      };
    } catch (error) {
      return hostRealizationFailure(error, 'The exact host projection apply is unavailable.');
    }
  });
  ipcMain.handle('host:realization-recover', async (event, request) => {
    assertSender(event);
    try {
      if (!exactObject(request, ['checkpointId', 'confirmed'])
        || typeof request.checkpointId !== 'string'
        || request.confirmed !== true) {
        throw new TypeError('Host realization recovery requires one exact checkpoint and explicit acknowledgement.');
      }
      const at = new Date().toISOString();
      const checkpoint = recoverHostRealization({ root, checkpointId: request.checkpointId, at });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectHostRealization({
          root,
          planId: checkpoint.plan.id,
          requestId: checkpoint.request.id,
          confirmationId: checkpoint.confirmation.id,
          consumptionId: checkpoint.consumption.id,
          checkpointId: checkpoint.id,
          at
        })
      };
    } catch (error) {
      return hostRealizationFailure(error, 'The exact host realization checkpoint could not be recovered.');
    }
  });
  ipcMain.handle('host:realization-inspect', async (event, request) => {
    assertSender(event);
    try {
      const allowed = new Set(['planId', 'requestId', 'confirmationId', 'consumptionId', 'checkpointId']);
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.planId !== 'string'
        || Object.keys(request).some((key) => !allowed.has(key))
        || ['requestId', 'confirmationId', 'consumptionId', 'checkpointId']
          .some((key) => request[key] !== undefined && typeof request[key] !== 'string')) {
        throw new TypeError('Host realization inspection requires one exact plan and optional bound references.');
      }
      return {
        ok: true,
        inspection: inspectHostRealization({
          root,
          planId: request.planId,
          requestId: request.requestId || null,
          confirmationId: request.confirmationId || null,
          consumptionId: request.consumptionId || null,
          checkpointId: request.checkpointId || null,
          at: new Date().toISOString()
        })
      };
    } catch (error) {
      return hostRealizationFailure(error, 'The exact host realization inspection is unavailable.');
    }
  });
  ipcMain.handle('operator:inspect', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('Operator inspection requires one canonical activity reference.');
    }
    const reference = {
      requestId: typeof request.requestId === 'string' ? request.requestId : null,
      approvalId: typeof request.approvalId === 'string' ? request.approvalId : null,
      checkpointId: typeof request.checkpointId === 'string' ? request.checkpointId : null
    };
    if (!reference.requestId && !reference.approvalId && !reference.checkpointId) {
      throw new TypeError('Operator inspection requires a request, approval, or checkpoint id.');
    }
    return inspectConnectedOperatorActivity({ root, ...reference });
  });
  ipcMain.handle('operator:prepared-inspect', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.workId !== 'string') {
      throw new TypeError('Prepared-work inspection requires one exact work id.');
    }
    return inspectPreparedAutomationWork({ root, workId: request.workId });
  });
  ipcMain.handle('operator:prepared-review', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.workId !== 'string') {
      throw new TypeError('Prepared-work private review requires one exact work id.');
    }
    try {
      return {
        ok: true,
        material: inspectPreparedAutomationReviewMaterial({ root, workId: request.workId })
      };
    } catch (error) {
      const canonicalError = typeof error?.code === 'string'
        && preparedReviewErrorCodes.has(error.code);
      return {
        ok: false,
        error: {
          code: canonicalError
            ? error.code
            : 'PREPARED_REVIEW_ADAPTER_UNAVAILABLE',
          message: canonicalError && error instanceof Error
            ? error.message
            : 'Private review material is unavailable for this prepared work.'
        }
      };
    }
  });
  ipcMain.handle('operator:prepared-derived-review', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1
      || typeof request.workId !== 'string') {
      throw new TypeError('Prepared-work private derived review requires one exact work id.');
    }
    try {
      return {
        ok: true,
        material: inspectPreparedAutomationDerivedReviewMaterial({ root, workId: request.workId })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' && preparedDerivedReviewErrorCodes.has(error.code)
            ? error.code
            : 'PREPARED_DERIVED_REVIEW_ADAPTER_UNAVAILABLE',
          message: 'Private derived review material is unavailable for this prepared work.'
        }
      };
    }
  });
  ipcMain.handle('operator:review-only-candidate-selection-create', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 2
      || typeof request.workId !== 'string'
      || !Array.isArray(request.actionIds)
      || request.actionIds.length < 1
      || request.actionIds.some((id) => typeof id !== 'string')) {
      throw new TypeError('Review-only candidate selection requires one exact work id and proposed action ids.');
    }
    try {
      return {
        ok: true,
        selection: createReviewOnlyCandidateSelection({
          root,
          workId: request.workId,
          actionIds: request.actionIds,
          createdAt: new Date().toISOString()
        })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' && reviewOnlyCandidateSelectionErrorCodes.has(error.code)
            ? error.code
            : 'REVIEW_ONLY_CANDIDATE_SELECTION_ADAPTER_UNAVAILABLE',
          message: 'The exact review-only selection is unavailable for this prepared work.'
        }
      };
    }
  });
  ipcMain.handle('operator:review-only-candidate-selection', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1
      || typeof request.selectionId !== 'string') {
      throw new TypeError('Review-only candidate material requires one exact selection id.');
    }
    try {
      return {
        ok: true,
        material: inspectReviewOnlyCandidateSelectionMaterial({ root, selectionId: request.selectionId })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' && reviewOnlyCandidateSelectionMaterialErrorCodes.has(error.code)
            ? error.code
            : 'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_ADAPTER_UNAVAILABLE',
          message: 'Private review-only candidate selection material is unavailable.'
        }
      };
    }
  });
  ipcMain.handle('operator:review-only-candidate-preview-create', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1
      || typeof request.selectionId !== 'string') {
      throw new TypeError('Review-only candidate preview requires one exact selection id.');
    }
    try {
      return {
        ok: true,
        preview: await createReviewOnlyCandidatePreview({
          root,
          selectionId: request.selectionId,
          createdAt: new Date().toISOString()
        })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' && reviewOnlyCandidatePreviewErrorCodes.has(error.code)
            ? error.code
            : 'REVIEW_ONLY_CANDIDATE_PREVIEW_ADAPTER_UNAVAILABLE',
          message: 'The private review-only candidate preview is unavailable for this selection.'
        }
      };
    }
  });
  ipcMain.handle('operator:review-only-candidate-preview', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1
      || typeof request.candidatePreviewId !== 'string') {
      throw new TypeError('Private review-only candidate preview requires one exact preview id.');
    }
    try {
      return {
        ok: true,
        preview: await inspectReviewOnlyCandidatePreview({ root, candidatePreviewId: request.candidatePreviewId })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' && reviewOnlyCandidatePreviewErrorCodes.has(error.code)
            ? error.code
            : 'REVIEW_ONLY_CANDIDATE_PREVIEW_ADAPTER_UNAVAILABLE',
          message: 'Private review-only candidate preview material is unavailable.'
        }
      };
    }
  });
  ipcMain.handle('operator:automation-proposal', async (event, request) => {
    assertSender(event);
    try {
      const { adapter, exact } = automationProposalLock(root, request);
      return {
        ok: true,
        proposal: adapter.load({ root, ...exact }).proposal
      };
    } catch (error) {
      const code = typeof error?.code === 'string'
        && (automationProposalErrorCodes.has(error.code)
          || automationProposalMaterialErrorCodes.has(error.code))
        ? error.code
        : 'AUTOMATION_PROPOSAL_TRANSPORT_UNAVAILABLE';
      return {
        ok: false,
        error: {
          code,
          message: 'The selected review-only proposal is unavailable.'
        }
      };
    }
  });
  ipcMain.handle('operator:automation-proposal-material', async (event, request) => {
    assertSender(event);
    try {
      const { adapter, exact } = automationProposalLock(root, request);
      return {
        ok: true,
        material: adapter.inspectMaterial({ root, ...exact })
      };
    } catch (error) {
      const code = typeof error?.code === 'string'
        && (automationProposalErrorCodes.has(error.code)
          || automationProposalMaterialErrorCodes.has(error.code))
        ? error.code
        : 'AUTOMATION_PROPOSAL_MATERIAL_TRANSPORT_UNAVAILABLE';
      return {
        ok: false,
        error: {
          code,
          message: 'Private proposal material is unavailable for this selected proposal.'
        }
      };
    }
  });
  ipcMain.handle('operator:proposal-connected-preview', async (event, request) => {
    assertSender(event);
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).sort().join(',') !== 'actionIds,configurationName,lockFingerprint,proposalId'
        || !Array.isArray(request.actionIds)
        || request.actionIds.length < 1
        || request.actionIds.some((id) => typeof id !== 'string')) {
        throw new TypeError('Connected proposal preview requires one exact proposal and proposed action IDs.');
      }
      const { adapter, exact } = automationProposalLock(root, {
        proposalId: request.proposalId,
        configurationName: request.configurationName,
        lockFingerprint: request.lockFingerprint
      });
      const id = randomUUID();
      return {
        ok: true,
        preview: await createProposalConnectedBatch({
          root,
          ...exact,
          actionIds: request.actionIds,
          changeSetId: `changeset.${adapter.idNamespace}.${id}`,
          batchId: `batch.${adapter.idNamespace}.${id}`,
          createdAt: new Date().toISOString()
        })
      };
    } catch (error) {
      return {
        ok: false,
        error: sanitizedConnectedActionError(error, {
          allowedCodes: new Set([
            ...proposalConnectedBatchErrorCodes,
            ...automationProposalErrorCodes,
            ...automationProposalMaterialErrorCodes
          ]),
          fallbackCode: 'PROPOSAL_CONNECTED_BATCH_ADAPTER_UNAVAILABLE',
          fallbackMessage: 'The exact connected proposal preview is unavailable.'
        })
      };
    }
  });
  ipcMain.handle('operator:proposal-connected-approval-request', async (event, request) => {
    assertSender(event);
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).sort().join(',') !== 'preview,proposal'
        || !request.proposal || typeof request.proposal !== 'object'
        || !request.preview || typeof request.preview !== 'object') {
        throw new TypeError('Connected approval request requires one exact canonical proposal preview.');
      }
      const { adapter, exact } = automationProposalLock(root, request.proposal);
      const proposal = adapter.load({ root, ...exact });
      const batch = request.preview.batch;
      const changeSet = request.preview.changeSet;
      if (batch?.$contract !== 'soter://contracts/connected-operation-batch/v2') {
        throw new TypeError('Automation proposal approval requires the canonical v2 connected operation batch.');
      }
      const createdAt = new Date();
      const id = `approval-request.${adapter.idNamespace}.${randomUUID()}`;
      const begun = await beginProposalConnectedApprovalRequest({
        root,
        configurationBasis: 'private-active',
        lockPath: exact.lockPath,
        runPath: proposal.runPath,
        batch,
        changeSet,
        id,
        reason: `Review and approve this exact selected ${adapter.reviewLabel} proposal subset.`,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString()
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConnectedOperatorActivity({ root, requestId: begun.request.id })
      };
    } catch (error) {
      return {
        ok: false,
        error: sanitizedConnectedActionError(error, {
          allowedCodes: new Set([
            ...proposalConnectedBatchErrorCodes,
            ...automationProposalErrorCodes,
            ...automationProposalMaterialErrorCodes
          ]),
          fallbackCode: 'PROPOSAL_CONNECTED_APPROVAL_ADAPTER_UNAVAILABLE',
          fallbackMessage: 'The exact connected approval request is unavailable.'
        })
      };
    }
  });
  ipcMain.handle('operator:approval-review', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1
      || typeof request.requestId !== 'string') {
      throw new TypeError('Connected approval private review requires one exact request id.');
    }
    try {
      return {
        ok: true,
        material: inspectConnectedApprovalReviewMaterial({ root, requestId: request.requestId })
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' && connectedApprovalReviewErrorCodes.has(error.code)
            ? error.code
            : 'CONNECTED_APPROVAL_REVIEW_ADAPTER_UNAVAILABLE',
          message: 'Private approval review material is unavailable for this selected activity.'
        }
      };
    }
  });
  ipcMain.handle('operator:prepare', async (event, request) => {
    assertSender(event);
    const requestKeys = request && typeof request === 'object' && !Array.isArray(request)
      ? Object.keys(request)
      : [];
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || requestKeys.length !== 5
      || requestKeys.some((key) => ![
        'automationId',
        'configurationName',
        'configurationBasis',
        'preparationMode',
        'input'
      ].includes(key))
      || typeof request.automationId !== 'string'
      || typeof request.configurationName !== 'string'
      || !['tracked-contained', 'private-active'].includes(request.configurationBasis)
      || !['contained', 'connected-acquisition'].includes(request.preparationMode)
      || (request.preparationMode === 'connected-acquisition'
        && request.configurationBasis !== 'private-active')
      || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)
      || Object.values(request.input).some((value) => !(
        ['string', 'boolean'].includes(typeof value)
        || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      ))) {
      throw new TypeError('Automation preparation requires one explicit supported preparation mode, a compatible configuration basis, and declared inputs.');
    }
    const result = await prepareAutomationRun({
      root,
      automationId: request.automationId,
      configurationName: request.configurationName,
      configurationBasis: request.configurationBasis,
      preparationMode: request.preparationMode,
      input: request.input,
      createdAt: new Date().toISOString()
    });
    workspaceWatcher.invalidate();
    return result;
  });
  ipcMain.handle('operator:approval-confirm', async (event, request) => {
    assertSender(event);
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || request.confirmed !== true
        || typeof request.requestId !== 'string'
        || typeof request.approvalId !== 'string') {
        throw new TypeError('Approval requires an explicit decision and canonical request and approval ids.');
      }
      const confirmedAt = new Date().toISOString();
      const result = await confirmProposalConnectedApprovalRequest({
        root,
        requestId: request.requestId,
        approvalId: request.approvalId,
        actor: 'local-studio-operator',
        reason: typeof request.reason === 'string' ? request.reason : 'Approved in Soter Studio after exact-scope review',
        confirmedAt
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConnectedOperatorActivity({ root, approvalId: result.approval.id })
      };
    } catch (error) {
      return {
        ok: false,
        error: sanitizedConnectedActionError(error, {
          allowedCodes: connectedApprovalActionErrorCodes,
          fallbackCode: 'CONNECTED_APPROVAL_CONFIRM_ADAPTER_UNAVAILABLE',
          fallbackMessage: 'The exact connected approval could not be confirmed.'
        })
      };
    }
  });
  ipcMain.handle('operator:transaction-start', async (event, request) => {
    assertSender(event);
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.approvalId !== 'string') {
        throw new TypeError('Starting a connected transaction requires one canonical approval id.');
      }
      const result = await prepareDurableConnectedTransactionExecution({
        root,
        approvalId: request.approvalId,
        at: new Date().toISOString()
      });
      workspaceWatcher.invalidate();
      return {
        ok: true,
        inspection: inspectConnectedOperatorActivity({ root, checkpointId: result.checkpoint.id })
      };
    } catch (error) {
      return {
        ok: false,
        error: sanitizedConnectedActionError(error, {
          allowedCodes: connectedTransactionStartErrorCodes,
          fallbackCode: 'CONNECTED_TRANSACTION_START_ADAPTER_UNAVAILABLE',
          fallbackMessage: 'The exact connected transaction could not be started.'
        })
      };
    }
  });
  ipcMain.handle('operator:reconciliation-prepare', async (event, request) => {
    assertSender(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.checkpointId !== 'string') {
      throw new TypeError('Reconciliation preparation requires one canonical checkpoint id.');
    }
    const current = inspectConnectedOperatorActivity({ root, checkpointId: request.checkpointId });
    if (current.continuationRequest?.kind !== 'prepare-reconciliation'
      || current.resume.classification !== 'safe') {
      throw new Error('The exact checkpoint does not authorize a read-only reconciliation request.');
    }
    const result = await prepareDurableConnectedTransactionReconciliation({
      root,
      checkpointId: current.continuationRequest.checkpointId,
      at: new Date().toISOString()
    });
    workspaceWatcher.invalidate();
    return inspectConnectedOperatorActivity({ root, checkpointId: result.checkpoint.id });
  });

  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadURL('soter-studio://app/index.html#/explore');
  return window;
}

app.whenReady().then(async () => {
  registerRendererProtocol();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
