'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soterStudio', Object.freeze({
  getWorkspaceSnapshot: () => ipcRenderer.invoke('workspace:get'),
  refreshWorkspaceSnapshot: () => ipcRenderer.invoke('workspace:refresh'),
  inspectLocalPackRelease: () => ipcRenderer.invoke('distribution:inspect-release'),
  inspectLocalBundle: () => ipcRenderer.invoke('distribution:inspect-bundle'),
  preparePackInstall: () => ipcRenderer.invoke('pack-install:plan'),
  beginPackInstallRequest: (request) => ipcRenderer.invoke('pack-install:request', request),
  confirmPackInstallRequest: (request) => ipcRenderer.invoke('pack-install:confirm', request),
  startPackInstall: (request) => ipcRenderer.invoke('pack-install:start', request),
  executePackInstall: (request) => ipcRenderer.invoke('pack-install:execute', request),
  recoverPackInstall: (request) => ipcRenderer.invoke('pack-install:recover', request),
  inspectPackInstall: (request) => ipcRenderer.invoke('pack-install:inspect', request),
  previewConfiguration: (request) => ipcRenderer.invoke('configuration:preview', request),
  prepareConfigurationChange: (request) => ipcRenderer.invoke('configuration:change-plan', request),
  beginConfigurationChangeRequest: (request) => ipcRenderer.invoke('configuration:change-request', request),
  confirmConfigurationChangeRequest: (request) => ipcRenderer.invoke('configuration:change-confirm', request),
  startConfigurationChange: (request) => ipcRenderer.invoke('configuration:change-start', request),
  executeConfigurationChange: (request) => ipcRenderer.invoke('configuration:change-execute', request),
  recoverConfigurationChange: (request) => ipcRenderer.invoke('configuration:change-recover', request),
  inspectConfigurationChange: (request) => ipcRenderer.invoke('configuration:change-inspect', request),
  prepareHostRealization: (request) => ipcRenderer.invoke('host:realization-plan', request),
  beginHostRealizationRequest: (request) => ipcRenderer.invoke('host:realization-request', request),
  confirmHostRealizationRequest: (request) => ipcRenderer.invoke('host:realization-confirm', request),
  startHostRealization: (request) => ipcRenderer.invoke('host:realization-start', request),
  executeHostRealization: (request) => ipcRenderer.invoke('host:realization-execute', request),
  recoverHostRealization: (request) => ipcRenderer.invoke('host:realization-recover', request),
  inspectHostRealization: (request) => ipcRenderer.invoke('host:realization-inspect', request),
  getOperatorActivity: (request) => ipcRenderer.invoke('operator:inspect', request),
  getPreparedWork: (request) => ipcRenderer.invoke('operator:prepared-inspect', request),
  getPreparedWorkReview: (request) => ipcRenderer.invoke('operator:prepared-review', request),
  getPreparedWorkDerivedReview: (request) => ipcRenderer.invoke('operator:prepared-derived-review', request),
  createPreparedReviewBatch: (request) => ipcRenderer.invoke('operator:review-batch-create', request),
  getPreparedReviewBatchMaterial: (request) => ipcRenderer.invoke('operator:review-batch', request),
  createPreparedConnectedPlan: (request) => ipcRenderer.invoke('operator:connected-plan-create', request),
  getPreparedConnectedPlan: (request) => ipcRenderer.invoke('operator:connected-plan', request),
  getAutomationProposal: (request) => ipcRenderer.invoke('operator:automation-proposal', request),
  getAutomationProposalMaterial: (request) => ipcRenderer.invoke('operator:automation-proposal-material', request),
  previewProposalConnectedBatch: (request) => ipcRenderer.invoke('operator:proposal-connected-preview', request),
  beginProposalConnectedApproval: (request) => ipcRenderer.invoke('operator:proposal-connected-approval-request', request),
  getConnectedApprovalReview: (request) => ipcRenderer.invoke('operator:approval-review', request),
  prepareAutomationRun: (request) => ipcRenderer.invoke('operator:prepare', request),
  confirmConnectedApproval: (request) => ipcRenderer.invoke('operator:approval-confirm', request),
  startConnectedTransaction: (request) => ipcRenderer.invoke('operator:transaction-start', request),
  prepareConnectedReconciliation: (request) => ipcRenderer.invoke('operator:reconciliation-prepare', request),
  onWorkspaceInvalidated: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Workspace invalidation callback must be a function.');
    const listener = () => callback();
    ipcRenderer.on('workspace:invalidated', listener);
    return () => ipcRenderer.removeListener('workspace:invalidated', listener);
  }
}));
