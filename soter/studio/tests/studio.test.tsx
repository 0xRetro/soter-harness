import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import automationDerivedReviewSchema from '../../contracts/automation-derived-review.schema.json';
import automationInputSchema from '../../contracts/automation-input.schema.json';
import automationProposalMaterialSchema from '../../contracts/automation-proposal-material.schema.json';
import automationProposalSchema from '../../contracts/automation-proposal.schema.json';
import automationReviewSchema from '../../contracts/automation-review.schema.json';
import connectedApprovalReviewSchema from '../../contracts/connected-approval-review-material.schema.json';
import connectedChangeSetV2Schema from '../../contracts/connected-change-set-v2.schema.json';
import connectedOperationBatchV2Schema from '../../contracts/connected-operation-batch-v2.schema.json';
import configurationChangeInspectionSchema from '../../contracts/configuration-change-inspection.schema.json';
import bundleInspectionSchema from '../../contracts/bundle-inspection.schema.json';
import hostRealizationInspectionSchema from '../../contracts/host-realization-inspection.schema.json';
import packInstallInspectionSchema from '../../contracts/pack-install-inspection.schema.json';
import packReleaseInspectionSchema from '../../contracts/pack-release-inspection.schema.json';
import operatorInspectionSchema from '../../contracts/operator-inspection.schema.json';
import preparedConnectedPlanSchema from '../../contracts/prepared-connected-plan.schema.json';
import preparedReviewBatchMaterialSchema from '../../contracts/prepared-review-batch-material.schema.json';
import preparedReviewBatchSchema from '../../contracts/prepared-review-batch.schema.json';
import preparedWorkDerivedReviewSchema from '../../contracts/prepared-work-derived-review-material.schema.json';
import preparedWorkReviewSchema from '../../contracts/prepared-work-review-material.schema.json';
import preparedWorkSchema from '../../contracts/prepared-work.schema.json';
import workspaceInspectionSchema from '../../contracts/workspace-inspection.schema.json';
import emailDerivedReviewDefinition from '../../automations/email-triage/derived-review.json';
// @ts-expect-error The canonical verifier is a checked JavaScript module without a declaration file.
import { validateJsonSchema } from '../../kernel/verify.mjs';

import { App } from '../renderer/src/App';
import { ConfigView } from '../renderer/src/components/ConfigView';
import { DistributionView } from '../renderer/src/components/DistributionView';
import { HostRealizationDesk } from '../renderer/src/components/HostRealizationDesk';
import { PackInstallDesk } from '../renderer/src/components/PackInstallDesk';
import { OperatorInputControl } from '../renderer/src/components/OperatorInputControl';
import { OperatorView } from '../renderer/src/components/OperatorView';
import { previewTitle } from '../renderer/src/components/PreparedWorkDossier';
import { RunsView } from '../renderer/src/components/RunsView';
import type { ConnectedApprovalReviewMaterial, OperatorInputField, OperatorInspection } from '../renderer/src/types';
import { bundleInspectionFixture, configurationChangeInspectionFixture, configurationPreviewFixture, connectedActivityFixture, emailConnectedAcquisitionActivityFixture, emailTriageAutomationProposalFixture, emailTriageAutomationProposalMaterialFixture, emailTriageConfigurationFixture, emailTriageConnectedPlanFixture, emailTriageDerivedReviewFixture, emailTriagePreparedWorkFixture, emailTriageProposalConnectedPreviewFixture, emailTriageReviewBatchFixture, emailTriageReviewBatchMaterialFixture, emailTriageReviewFixture, emailTriageWorkflowFixture, hostRealizationInspectionFixture, meetingIntakePreparedWorkFixture, operatorInspectionFixture, operatorRecoveryInspectionFixture, packInstallInspectionFixture, packReleaseInspectionFixture, preparedWorkFixture, preparedWorkReviewFixture, studioFixture, taskCaptureConfigurationFixture, taskCapturePreparedWorkFixture, taskCaptureReviewFixture, taskCaptureWorkflowFixture } from './fixture';

beforeEach(() => {
  const snapshot = studioFixture();
  window.location.hash = '#/operate/automation.project-pulse';
  window.soterStudio = {
    getWorkspaceSnapshot: vi.fn().mockResolvedValue(snapshot),
    refreshWorkspaceSnapshot: vi.fn().mockResolvedValue(snapshot),
    inspectLocalPackRelease: vi.fn().mockResolvedValue({ ok: true as const, inspection: packReleaseInspectionFixture() }),
    inspectLocalBundle: vi.fn().mockResolvedValue({ ok: true as const, inspection: bundleInspectionFixture() }),
    preparePackInstall: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('plan') }),
    beginPackInstallRequest: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('request') }),
    confirmPackInstallRequest: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('confirmed') }),
    startPackInstall: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('started') }),
    executePackInstall: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('completed') }),
    recoverPackInstall: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('completed') }),
    inspectPackInstall: vi.fn().mockResolvedValue({ ok: true as const, inspection: packInstallInspectionFixture('recoverable') }),
    previewConfiguration: vi.fn().mockImplementation((request) => Promise.resolve(configurationPreviewFixture(request))),
    prepareConfigurationChange: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('plan') }),
    beginConfigurationChangeRequest: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('request') }),
    confirmConfigurationChangeRequest: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('confirmed') }),
    startConfigurationChange: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('started') }),
    executeConfigurationChange: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('completed') }),
    recoverConfigurationChange: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('completed') }),
    inspectConfigurationChange: vi.fn().mockResolvedValue({ ok: true as const, inspection: configurationChangeInspectionFixture('started') }),
    prepareHostRealization: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('plan') }),
    beginHostRealizationRequest: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('request') }),
    confirmHostRealizationRequest: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('confirmed') }),
    startHostRealization: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('started') }),
    executeHostRealization: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('completed') }),
    recoverHostRealization: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('completed') }),
    inspectHostRealization: vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('started') }),
    getOperatorActivity: vi.fn().mockResolvedValue(operatorInspectionFixture()),
    getPreparedWork: vi.fn().mockImplementation((request: { workId: string }) => Promise.resolve(request.workId.includes('email-triage') ? emailTriagePreparedWorkFixture() : request.workId.includes('task-capture') ? taskCapturePreparedWorkFixture() : request.workId.includes('meeting-intake') ? meetingIntakePreparedWorkFixture() : preparedWorkFixture())),
    getPreparedWorkReview: vi.fn().mockImplementation((request: { workId: string }) => Promise.resolve({ ok: true as const, material: request.workId.includes('email-triage') ? emailTriageReviewFixture() : request.workId.includes('task-capture') ? taskCaptureReviewFixture() : preparedWorkReviewFixture(request.workId) })),
    getPreparedWorkDerivedReview: vi.fn().mockImplementation((request: { workId: string }) => Promise.resolve(request.workId.includes('email-triage')
      ? { ok: true as const, material: emailTriageDerivedReviewFixture() }
      : { ok: false as const, error: { code: 'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING', message: 'Private derived review material is unavailable for this prepared work.' } })),
    createPreparedReviewBatch: vi.fn().mockResolvedValue({ ok: true as const, batch: emailTriageReviewBatchFixture() }),
    getPreparedReviewBatchMaterial: vi.fn().mockResolvedValue({ ok: true as const, material: emailTriageReviewBatchMaterialFixture() }),
    createPreparedConnectedPlan: vi.fn().mockResolvedValue({ ok: true as const, plan: emailTriageConnectedPlanFixture() }),
    getPreparedConnectedPlan: vi.fn().mockResolvedValue({ ok: true as const, plan: emailTriageConnectedPlanFixture() }),
    getAutomationProposal: vi.fn().mockResolvedValue({ ok: true as const, proposal: emailTriageAutomationProposalFixture() }),
    getAutomationProposalMaterial: vi.fn().mockResolvedValue({ ok: true as const, material: emailTriageAutomationProposalMaterialFixture() }),
    previewProposalConnectedBatch: vi.fn().mockResolvedValue({ ok: true as const, preview: emailTriageProposalConnectedPreviewFixture() }),
    beginProposalConnectedApproval: vi.fn().mockResolvedValue({ ok: true as const, inspection: operatorInspectionFixture() }),
    getConnectedApprovalReview: vi.fn().mockResolvedValue({ ok: true as const, material: testConnectedApprovalReview(operatorInspectionFixture()) }),
    prepareAutomationRun: vi.fn().mockImplementation((request: { automationId: string }) => Promise.resolve(request.automationId === 'automation.email-triage' ? emailTriagePreparedWorkFixture() : request.automationId === 'automation.task-capture' ? taskCapturePreparedWorkFixture() : request.automationId === 'automation.meeting-intake' ? meetingIntakePreparedWorkFixture() : preparedWorkFixture())),
    confirmConnectedApproval: vi.fn().mockResolvedValue(operatorInspectionFixture('approved-not-started')),
    startConnectedTransaction: vi.fn().mockResolvedValue(operatorInspectionFixture('running')),
    prepareConnectedReconciliation: vi.fn().mockResolvedValue(operatorInspectionFixture('running')),
    onWorkspaceInvalidated: vi.fn().mockReturnValue(() => undefined)
  };
});

describe('Soter Studio canonical operator projection', () => {
  it('derives new automation preview labels mechanically from contract kinds', () => {
    expect(previewTitle('project-pulse-status')).toBe('Project Pulse');
    expect(previewTitle('meeting-intake-review')).toBe('Meeting Intake');
    expect(previewTitle('task-capture-preview')).toBe('Task Capture');
  });

  it('renders schema-valid release evidence without implying install, trust, or runtime claims', async () => {
    const user = userEvent.setup();
    const release = packReleaseInspectionFixture();
    expect(validateJsonSchema(release, packReleaseInspectionSchema)).toEqual([]);
    const hostile = structuredClone(release) as typeof release & { sourceRoot?: string; capsuleBytes?: string };
    hostile.sourceRoot = '/private/distribution/source/SOURCE_ROOT_SENTINEL';
    hostile.capsuleBytes = 'CAPSULE_BYTES_SENTINEL';
    window.soterStudio.inspectLocalPackRelease = vi.fn().mockResolvedValue({ ok: true, inspection: hostile });
    const { container } = render(<DistributionView />);

    expect(screen.getByText('The ledger begins with local bytes, not a catalog promise.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Inspect local capsule' }));

    expect(await screen.findByRole('heading', { name: 'kernel.soter' })).toBeVisible();
    expect(screen.getByText('PACK_RELEASE_BYTES_VERIFIED')).toBeVisible();
    expect(screen.getByText('PACK_RELEASE_SOURCE_NOT_EVALUATED')).toBeVisible();
    expect(screen.getByText('Byte facts stop before trust and runtime claims.')).toBeVisible();
    expect(screen.getByText('unsigned-untrusted')).toBeVisible();
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(3);
    const releaseLedger = screen.getByRole('article', { name: 'Pack release kernel.soter' });
    expect(within(releaseLedger).queryByRole('button', { name: /install|configure|publish|trust|marketplace|auto-update/i })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SOURCE_ROOT_SENTINEL');
    expect(document.body).not.toHaveTextContent('CAPSULE_BYTES_SENTINEL');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('keeps replacement release branches structurally discriminated', () => {
    const release = packReleaseInspectionFixture();
    const absentIntent = structuredClone(release);
    absentIntent.packageIntent = { state: 'absent', private: null, sourceFingerprint: null, interpretation: 'packaging-intent-only' };
    expect(validateJsonSchema(absentIntent, packReleaseInspectionSchema)).toEqual([]);
    const unavailableIntent = structuredClone(release);
    unavailableIntent.packageIntent = { state: 'unavailable', private: null, sourceFingerprint: null, interpretation: 'packaging-intent-only' };
    expect(validateJsonSchema(unavailableIntent, packReleaseInspectionSchema)).toEqual([]);

    const mismatchedSourcePair = structuredClone(release) as unknown as { sourceComparison: { state: string; reasonCode: string } };
    mismatchedSourcePair.sourceComparison = { state: 'passed', reasonCode: 'PACK_RELEASE_SOURCE_MISMATCH' };
    expect(validateJsonSchema(mismatchedSourcePair, packReleaseInspectionSchema).length).toBeGreaterThan(0);
    const shortGitRevision = structuredClone(release) as unknown as { provenance: { revision: string } };
    shortGitRevision.provenance.revision = '97ea7c4';
    expect(validateJsonSchema(shortGitRevision, packReleaseInspectionSchema).length).toBeGreaterThan(0);
    const invalidAbsentIntent = structuredClone(absentIntent) as unknown as { packageIntent: { private: boolean | null } };
    invalidAbsentIntent.packageIntent.private = true;
    expect(validateJsonSchema(invalidAbsentIntent, packReleaseInspectionSchema).length).toBeGreaterThan(0);
  });

  it('shows a missing optional dependency without blocking or degrading runtime claims', async () => {
    const user = userEvent.setup();
    const resolved = bundleInspectionFixture('resolved');
    expect(validateJsonSchema(resolved, bundleInspectionSchema)).toEqual([]);
    window.soterStudio.inspectLocalBundle = vi.fn().mockResolvedValue({ ok: true, inspection: resolved });
    render(<DistributionView />);
    await user.click(screen.getByRole('button', { name: 'Inspect local bundle' }));

    expect(await screen.findByText('BUNDLE_RESOLVED')).toBeVisible();
    expect(screen.getByText('kernel.soter → context.optional ^1.0.0 · optional')).toBeVisible();
    expect(screen.queryByText('BUNDLE_DEPENDENCY_MISSING')).not.toBeInTheDocument();
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(3);

    const impossibleResolution = structuredClone(resolved) as unknown as { resolution: { blockers: unknown[] } };
    impossibleResolution.resolution.blockers = [{ code: 'BUNDLE_RELEASE_MISSING', referenceId: null, pack: 'kernel.soter', summary: 'Impossible blocker on a resolved bundle inspection.' }];
    expect(validateJsonSchema(impossibleResolution, bundleInspectionSchema).length).toBeGreaterThan(0);
    const impossibleReference = structuredClone(resolved) as unknown as { references: Array<{ selectedRelease: null }> };
    impossibleReference.references[0].selectedRelease = null;
    expect(validateJsonSchema(impossibleReference, bundleInspectionSchema).length).toBeGreaterThan(0);
  });

  it('keeps deterministic bundle blockers distinct from executable authority', async () => {
    const user = userEvent.setup();
    const blocked = bundleInspectionFixture('blocked');
    expect(validateJsonSchema(blocked, bundleInspectionSchema)).toEqual([]);
    window.soterStudio.inspectLocalBundle = vi.fn().mockResolvedValue({ ok: true, inspection: blocked });
    render(<DistributionView />);

    await user.click(screen.getByRole('button', { name: 'Inspect local bundle' }));

    expect(await screen.findByRole('heading', { name: 'bundle.soter-studio' })).toBeVisible();
    expect(screen.getByText('BUNDLE_BLOCKED')).toBeVisible();
    expect(screen.getByText('BUNDLE_RELEASE_MISSING')).toBeVisible();
    expect(screen.getByText('No local release was selected for this reference.')).toBeVisible();
    expect(screen.getByText('Artifact inspection grants no authority.')).toBeVisible();
    const bundleLedger = screen.getByRole('article', { name: 'Bundle bundle.soter-studio' });
    expect(within(bundleLedger).queryByRole('button', { name: /install|resolve|retry|fetch/i })).not.toBeInTheDocument();
  });

  it('renders and executes only the canonical checkpoint-bound local install ceremony', async () => {
    const user = userEvent.setup();
    const plan = packInstallInspectionFixture('plan');
    expect(validateJsonSchema(plan, packInstallInspectionSchema)).toEqual([]);
    const hostile = structuredClone(plan) as typeof plan & { targetRoot?: string };
    hostile.targetRoot = '/private/target/PACK_INSTALL_TARGET_SENTINEL';
    (hostile.plan!.effects[0] as unknown as Record<string, unknown>).path = 'private/PACK_INSTALL_OUTPUT_SENTINEL.json';
    expect(validateJsonSchema(hostile, packInstallInspectionSchema).length).toBeGreaterThan(0);
    window.soterStudio.preparePackInstall = vi.fn().mockResolvedValue({ ok: true, inspection: hostile });
    const { container } = render(<PackInstallDesk />);

    await user.click(screen.getByRole('button', { name: 'Select target and local releases' }));
    expect(await screen.findByText('PACK_INSTALL_DEPENDENCIES_RESOLVED')).toBeVisible();
    expect(screen.getByText('PACK_INSTALL_OPTIONAL_DEPENDENCY_ABSENT')).toBeVisible();
    expect(screen.getByText('Paths and bytes withheld')).toBeVisible();
    expect(document.body).not.toHaveTextContent('PACK_INSTALL_TARGET_SENTINEL');
    expect(document.body).not.toHaveTextContent('PACK_INSTALL_OUTPUT_SENTINEL');

    await user.click(screen.getByRole('button', { name: 'Request confirmation' }));
    expect(window.soterStudio.beginPackInstallRequest).toHaveBeenCalledWith({ planId: 'pack-install-plan.ui-test' });
    await user.click(screen.getByLabelText('I reviewed this exact fingerprint-bound install plan.'));
    await user.click(screen.getByRole('button', { name: 'Confirm exact install request' }));
    expect(window.soterStudio.confirmPackInstallRequest).toHaveBeenCalledWith({ requestId: 'pack-install-request.ui-test', confirmed: true });
    await user.click(screen.getByRole('button', { name: 'Start this exact install plan' }));
    expect(window.soterStudio.startPackInstall).toHaveBeenCalledWith({ confirmationId: 'pack-install-confirmation.ui-test' });

    const execute = screen.getByRole('button', { name: 'Install exact checkpoint' });
    expect(execute).toBeDisabled();
    await user.click(screen.getByLabelText("I understand this changes only the selected target's managed pack files."));
    expect(execute).toBeEnabled();
    await user.click(execute);
    expect(window.soterStudio.executePackInstall).toHaveBeenCalledWith({ checkpointId: 'checkpoint.pack-install.ui-test', confirmed: true });
    expect((await screen.findAllByText('PACK_INSTALL_COMPLETED')).length).toBeGreaterThan(0);
    expect(screen.getByText('Materialized locally does not mean configured or working.')).toBeVisible();
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(3);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('keeps checkpoint recovery reason-coded and discards hostile adapter prose', async () => {
    const user = userEvent.setup();
    window.soterStudio.preparePackInstall = vi.fn()
      .mockResolvedValueOnce({ ok: true, inspection: packInstallInspectionFixture('recoverable') })
      .mockRejectedValueOnce(new Error('PRIVATE_PACK_INSTALL_PATH_SENTINEL /private/target/root'));
    const view = render(<PackInstallDesk />);
    await user.click(screen.getByRole('button', { name: 'Select target and local releases' }));
    expect((await screen.findAllByText('PACK_INSTALL_RECOVERY_REQUIRED')).length).toBeGreaterThan(0);
    const recover = screen.getByRole('button', { name: 'Recover exact checkpoint' });
    expect(recover).toBeDisabled();
    await user.click(screen.getByLabelText("I understand this changes only the selected target's managed pack files."));
    expect(recover).toBeEnabled();
    expect(screen.getByText('Exact current step')).toBeVisible();
    view.unmount();

    render(<PackInstallDesk />);
    await user.click(screen.getByRole('button', { name: 'Select target and local releases' }));
    expect(await screen.findByText('PACK_INSTALL_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The exact local pack install adapter is unavailable.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('PRIVATE_PACK_INSTALL_PATH_SENTINEL');
    expect(document.body).not.toHaveTextContent('/private/target/root');
  });

  it('discards hostile local inspection adapter rejection prose', async () => {
    const user = userEvent.setup();
    window.soterStudio.inspectLocalPackRelease = vi.fn()
      .mockResolvedValueOnce({ ok: true, inspection: packReleaseInspectionFixture() })
      .mockRejectedValueOnce(new Error('PRIVATE_DISTRIBUTION_PATH_SENTINEL /Users/operator/private-release.soter-pack.json'));
    render(<DistributionView />);
    await user.click(screen.getByRole('button', { name: 'Inspect local capsule' }));
    expect(await screen.findByRole('heading', { name: 'kernel.soter' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Inspect local capsule' }));

    expect(await screen.findByText('DISTRIBUTION_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The local distribution inspection adapter is unavailable.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'kernel.soter' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE_DISTRIBUTION_PATH_SENTINEL');
    expect(document.body).not.toHaveTextContent('/Users/operator');
  });

  it('routes the release index separately from workspace catalog selection', async () => {
    window.location.hash = '#/distribution';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sealed release index' })).toBeVisible();
    expect(screen.getAllByText('Pack capsule', { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole('complementary', { name: 'Workspace proof' })).toBeVisible();
  });

  it('keeps configuration preview separate from the exact local transaction ceremony', async () => {
    const user = userEvent.setup();
    const snapshot = studioFixture();
    const configuration = snapshot.configurations.find((item) => item.name === 'meeting-intake')!;
    expect(validateJsonSchema(configurationChangeInspectionFixture('plan'), configurationChangeInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(configurationChangeInspectionFixture('started'), configurationChangeInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(configurationChangeInspectionFixture('completed'), configurationChangeInspectionSchema)).toEqual([]);
    const { container } = render(<ConfigView snapshot={snapshot} configuration={configuration} />);

    expect(await screen.findByText('Exact lock transfer')).toBeVisible();
    expect(screen.getByText('Separate transaction')).toBeVisible();
    const candidate = screen.getByLabelText('Complete private candidate');
    fireEvent.change(candidate, { target: { value: JSON.stringify({
      $contract: 'soter://contracts/configuration/v1',
      contractVersion: '1.0.0',
      name: 'meeting-intake',
      privateSentinel: 'PRIVATE_CONFIGURATION_CANDIDATE_SENTINEL'
    }) } });
    await user.click(screen.getByRole('button', { name: 'Seal exact private plan' }));

    expect(await screen.findByText('Fingerprint-only scope')).toBeVisible();
    expect(screen.queryByText('PRIVATE_CONFIGURATION_CANDIDATE_SENTINEL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Complete private candidate')).not.toBeInTheDocument();
    expect(window.soterStudio.prepareConfigurationChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'meeting-intake' }));

    await user.click(screen.getByRole('button', { name: 'Request confirmation' }));
    expect(await screen.findByText('Confirmation records the local actor decision. It does not start or write.')).toBeVisible();
    expect(window.soterStudio.confirmConfigurationChangeRequest).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText('I reviewed this exact fingerprint-only scope.'));
    await user.click(screen.getByRole('button', { name: 'Confirm exact request' }));
    expect(await screen.findByText('Reserve this confirmation once into one deterministic checkpoint. No desired file is changed yet.')).toBeVisible();
    expect(window.soterStudio.startConfigurationChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reserve one-time start' }));
    expect(await screen.findByRole('button', { name: 'Apply exact checkpoint' })).toBeDisabled();
    expect(window.soterStudio.executeConfigurationChange).not.toHaveBeenCalled();
    expect(screen.getByText('Core-derived guidance · not authority')).toBeVisible();
    expect(screen.getAllByText('No provider calls').length).toBeGreaterThan(0);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('discards hostile configuration adapter rejection prose', async () => {
    const user = userEvent.setup();
    const snapshot = studioFixture();
    window.soterStudio.prepareConfigurationChange = vi.fn().mockRejectedValue(new Error('PRIVATE_CONFIG_PATH_SENTINEL /private/operator/candidate.json'));
    render(<ConfigView snapshot={snapshot} configuration={snapshot.configurations[0]} />);
    fireEvent.change(await screen.findByLabelText('Complete private candidate'), { target: { value: JSON.stringify({
      $contract: 'soter://contracts/configuration/v1', name: snapshot.configurations[0].name
    }) } });
    await user.click(screen.getByRole('button', { name: 'Seal exact private plan' }));
    expect(await screen.findByText('CONFIGURATION_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The local configuration transaction adapter is unavailable.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('PRIVATE_CONFIG_PATH_SENTINEL');
    expect(document.body).not.toHaveTextContent('/private/operator/candidate.json');
  });

  it('drops private candidate state when configuration selection changes', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/config/meeting-intake';
    render(<App />);
    const candidate = await screen.findByLabelText('Complete private candidate');
    fireEvent.change(candidate, { target: { value: JSON.stringify({
      $contract: 'soter://contracts/configuration/v1',
      name: 'meeting-intake',
      privateSentinel: 'PRIVATE_CROSS_CONFIGURATION_SENTINEL'
    }) } });
    expect((candidate as HTMLTextAreaElement).value).toContain('PRIVATE_CROSS_CONFIGURATION_SENTINEL');

    await user.click(screen.getByRole('button', { name: /project-pulse/i }));
    expect(await screen.findByLabelText('Complete private candidate')).toHaveValue('');
    expect(document.body).not.toHaveTextContent('PRIVATE_CROSS_CONFIGURATION_SENTINEL');
  });

  it('renders host realization as a separate manifest-last exact-scope ceremony', async () => {
    const user = userEvent.setup();
    const snapshot = studioFixture();
    const configuration = snapshot.configurations.find((item) => item.name === 'meeting-intake')!;
    for (const stage of ['plan', 'started', 'recoverable', 'completed', 'needs-attention'] as const) {
      expect(validateJsonSchema(hostRealizationInspectionFixture(stage), hostRealizationInspectionSchema)).toEqual([]);
    }
    const { container } = render(<HostRealizationDesk configuration={configuration} />);

    expect(screen.getByText('Manifest-last projection')).toBeVisible();
    expect(screen.getByText('Current launch root · identity withheld')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));

    expect(await screen.findByText('Ordered whole-file scope')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Host realization lifecycle' })).getByText('Request').closest('li')).toHaveTextContent('pending');
    expect(screen.getByText('AGENTS.md')).toBeVisible();
    expect(screen.getByText('.codex/config.toml')).toBeVisible();
    expect(screen.getByText('.codex/legacy-tools.json')).toBeVisible();
    expect(screen.getByText('create')).toBeVisible();
    expect(screen.getByText('replace')).toBeVisible();
    expect(screen.getByText('remove')).toBeVisible();
    expect(screen.getByText('Managed ownership manifest')).toBeVisible();
    expect(document.body).not.toHaveTextContent('/private/consumer/root');

    await user.click(screen.getByRole('button', { name: 'Request confirmation' }));
    expect(await screen.findByText('Record a local actor decision only. No output or manifest changes yet.')).toBeVisible();
    await user.click(screen.getByLabelText('I reviewed every relative path, effect, mode, and fingerprint.'));
    await user.click(screen.getByRole('button', { name: 'Confirm exact request' }));
    expect(await screen.findByText('Consume this confirmation once into one durable checkpoint. Host outputs stay unchanged.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reserve one-time start' }));
    expect(await screen.findByRole('button', { name: 'Realize exact checkpoint' })).toBeDisabled();
    expect(window.soterStudio.executeHostRealization).not.toHaveBeenCalled();
    expect(screen.getByText('Local projection stops here')).toBeVisible();
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByRole('button', { name: /force|adopt|install|launch host|retry/i })).not.toBeInTheDocument();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('keeps stale, expired, collision, and hostile host errors non-executable and sanitized', async () => {
    const user = userEvent.setup();
    const configuration = studioFixture().configurations[0];
    window.soterStudio.prepareHostRealization = vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('stale') });
    let view = render(<HostRealizationDesk configuration={configuration} />);
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));
    expect(await screen.findByText('HOST_REALIZATION_PLAN_STALE')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request confirmation' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /realize exact|recover exact/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear and prepare a new plan' }));
    expect(screen.getByRole('button', { name: 'Prepare host projection' })).toBeVisible();
    view.unmount();

    window.soterStudio.prepareHostRealization = vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('request-expired') });
    view = render(<HostRealizationDesk configuration={configuration} />);
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));
    const renew = await screen.findByRole('button', { name: 'Request fresh confirmation' });
    expect(renew).toBeEnabled();
    await user.click(renew);
    expect(window.soterStudio.beginHostRealizationRequest).toHaveBeenCalledWith({ planId: hostRealizationInspectionFixture('request-expired').plan.id });
    view.unmount();

    window.soterStudio.prepareHostRealization = vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('expired') });
    view = render(<HostRealizationDesk configuration={configuration} />);
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));
    expect(await screen.findByText('HOST_REALIZATION_PLAN_EXPIRED')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear and prepare a new plan' })).toBeVisible();
    view.unmount();

    window.soterStudio.prepareHostRealization = vi.fn().mockResolvedValue({
      ok: false as const,
      error: { code: 'HOST_REALIZATION_UNMANAGED_COLLISION', message: 'The exact private host realization plan is unavailable.' }
    });
    render(<HostRealizationDesk configuration={configuration} />);
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));
    expect(await screen.findByText('HOST_REALIZATION_UNMANAGED_COLLISION')).toBeVisible();
    expect(screen.getByText('The exact private host realization plan is unavailable.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('/private/consumer/root');
  });

  it('enables recovery only from the exact recoverable host checkpoint and suppresses caught prose', async () => {
    const user = userEvent.setup();
    const configuration = studioFixture().configurations[0];
    window.soterStudio.prepareHostRealization = vi.fn().mockResolvedValue({ ok: true as const, inspection: hostRealizationInspectionFixture('recoverable') });
    const { unmount } = render(<HostRealizationDesk configuration={configuration} />);
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));
    const recover = await screen.findByRole('button', { name: 'Recover exact checkpoint' });
    expect(recover).toBeDisabled();
    await user.click(screen.getByLabelText('I understand this changes managed host files in the current launch root.'));
    expect(recover).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Realize exact checkpoint' })).not.toBeInTheDocument();
    unmount();

    window.soterStudio.prepareHostRealization = vi.fn().mockRejectedValue(new Error('HOST_RAW_ERROR /private/consumer/root CANDIDATE_BYTES_SENTINEL'));
    render(<HostRealizationDesk configuration={configuration} />);
    await user.click(screen.getByRole('button', { name: 'Prepare host projection' }));
    expect(await screen.findByText('HOST_REALIZATION_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The local host realization adapter is unavailable.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('HOST_RAW_ERROR');
    expect(document.body).not.toHaveTextContent('CANDIDATE_BYTES_SENTINEL');
    expect(document.body).not.toHaveTextContent('/private/consumer/root');
  });

  it('rejects hostile private host properties at the canonical inspection schema boundary', () => {
    const inspection = hostRealizationInspectionFixture('plan');
    expect(validateJsonSchema(inspection, hostRealizationInspectionSchema)).toEqual([]);
    const hostile = {
      ...inspection,
      consumerRoot: '/private/consumer/root',
      templateBytes: 'TEMPLATE_BYTES_SENTINEL',
      rawManifest: { providerData: 'RAW_PROVIDER_SENTINEL' }
    };
    expect(validateJsonSchema(hostile, hostRealizationInspectionSchema).length).toBeGreaterThan(0);
    expect(JSON.stringify(inspection)).not.toContain('/private/consumer/root');
    expect(JSON.stringify(inspection)).not.toContain('TEMPLATE_BYTES_SENTINEL');
    expect(JSON.stringify(inspection)).not.toContain('RAW_PROVIDER_SENTINEL');
  });

  it('projects connected Email acquisition as generic capability progress without workflow authority', async () => {
    const activity = emailConnectedAcquisitionActivityFixture();
    const snapshot = { ...studioFixture(), activity: [activity] };
    expect(validateJsonSchema(snapshot, workspaceInspectionSchema)).toEqual([]);
    const { container } = render(<RunsView activity={activity} />);

    expect(screen.getByText('Private local runtime · operation-plan')).toBeVisible();
    expect(screen.getByText('1 / 2')).toBeVisible();
    expect(screen.getByText('step.mail-message-search', { exact: false })).toBeVisible();
    expect(screen.getByText('step.mail-thread-expansion', { exact: false })).toBeVisible();
    expect(screen.getByText('cap · mail.messages.search')).toBeVisible();
    expect(screen.getByText('cap · mail.threads.read')).toBeVisible();
    const boundary = screen.getByRole('region', { name: 'Operation plan scope' });
    expect(boundary).toHaveTextContent('Capability progress, not workflow completion');
    expect(boundary).toHaveTextContent('They do not establish workflow outcomes, readiness, verification, health, proof, or authority.');
    expect(within(boundary).queryByRole('button')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('subject');
    expect(container).not.toHaveTextContent('body');
    expect(container).not.toHaveTextContent('approval');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('keeps typed renderer fixtures aligned with canonical inspection and input contracts', () => {
    const snapshot = studioFixture();
    expect(validateJsonSchema(snapshot, workspaceInspectionSchema)).toEqual([]);
    for (const workflow of [...snapshot.workflows, taskCaptureWorkflowFixture(), emailTriageWorkflowFixture()].filter((item) => item.operator)) {
      expect(validateJsonSchema({
        $contract: 'soter://contracts/automation-input/v1',
        contractVersion: '1.0.0',
        id: workflow.operator!.inputContract.id,
        automation: workflow.id,
        version: workflow.operator!.inputContract.version,
        fields: workflow.operator!.inputContract.fields,
        additionalInputs: workflow.operator!.inputContract.additionalInputs
      }, automationInputSchema)).toEqual([]);
    }
    expect(validateJsonSchema(preparedWorkFixture(), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(meetingIntakePreparedWorkFixture(), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(taskCapturePreparedWorkFixture(), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(taskCapturePreparedWorkFixture('duplicate'), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriagePreparedWorkFixture(), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(preparedWorkReviewFixture(), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(preparedWorkReviewFixture('work.meeting-intake.ui-test'), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(taskCaptureReviewFixture(), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageReviewFixture(), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailDerivedReviewDefinition, automationDerivedReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageDerivedReviewFixture(), preparedWorkDerivedReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageReviewBatchFixture(), preparedReviewBatchSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageReviewBatchMaterialFixture(), preparedReviewBatchMaterialSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageConnectedPlanFixture(), preparedConnectedPlanSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageAutomationProposalFixture().review, automationReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageAutomationProposalFixture(), automationProposalSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageAutomationProposalMaterialFixture(), automationProposalMaterialSchema)).toEqual([]);
    const connectedPreview = emailTriageProposalConnectedPreviewFixture();
    expect(validateJsonSchema(connectedPreview.changeSet, connectedChangeSetV2Schema)).toEqual([]);
    expect(validateJsonSchema(connectedPreview.batch, connectedOperationBatchV2Schema)).toEqual([]);
    const labelActionId = emailTriageReviewBatchFixture().actions.find((action) => action.kind === 'label')!.id;
    const labelOnlyPlan = emailTriageConnectedPlanFixture([labelActionId]);
    expect(validateJsonSchema(labelOnlyPlan, preparedConnectedPlanSchema)).toEqual([]);
    expect(labelOnlyPlan.operations).toHaveLength(1);
    expect(labelOnlyPlan.operations[0].provider).toEqual({
      pack: 'integration.gmail',
      connectedImplementation: 'provider.integration.gmail.mcp',
      version: '1.0.0'
    });
    expect(labelOnlyPlan.operations[0].precondition).toEqual({ kind: 'none', capability: null, input: null, inputFingerprint: null, expectation: null });
    expect(labelOnlyPlan.operations[0].review?.before).toEqual({ state: 'not-required', reasonCode: 'PRIOR_VALUE_NOT_REQUIRED', fingerprint: null });
    expect(labelOnlyPlan.operations[0].input).toEqual({
      messageIds: ['gmail-message.synthetic.001'],
      addLabelNames: ['AI/Synthetic/needs-you'],
      removeLabelNames: [],
      createMissingLabels: false
    });
    expect(labelOnlyPlan.operations[0].input).not.toHaveProperty('idempotencyKey');
    expect(labelOnlyPlan.operations[0].verification.input).toEqual({
      messageIds: ['gmail-message.synthetic.001'],
      labelNames: ['AI/Synthetic/needs-you'],
      maximumMessages: 1
    });
    expect(labelOnlyPlan.blockers).not.toContain('CONNECTED_PROVIDER_NOT_DECLARED');
    expect(labelOnlyPlan.blockers).toEqual([
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    expect(validateJsonSchema(operatorInspectionFixture(), operatorInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(testConnectedApprovalReview(operatorInspectionFixture()), connectedApprovalReviewSchema)).toEqual([]);
    for (const state of ['blocked', 'checkpoint-stale', 'verification-failed', 'rolling-back'] as const) {
      expect(validateJsonSchema(operatorRecoveryInspectionFixture(state), operatorInspectionSchema)).toEqual([]);
    }
  });

  it('mechanically prepares Task Capture with private review and a held create proposal', async () => {
    const snapshot = studioFixture();
    const workflow = taskCaptureWorkflowFixture();
    const configuration = taskCaptureConfigurationFixture();
    const { container } = render(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Task title'), 'PRIVATE_TASK_UI_SENTINEL');
    await userEvent.type(screen.getByLabelText('Project reference'), 'soter-fixture://crm/project/launch');
    await userEvent.type(screen.getByLabelText('Assignee reference'), 'provider-person.maya');
    await userEvent.type(screen.getByLabelText('Next action date'), '2026-07-24');
    await userEvent.selectOptions(screen.getByLabelText('Task context'), 'Project');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      input: {
        title: 'PRIVATE_TASK_UI_SENTINEL',
        project: 'soter-fixture://crm/project/launch',
        assignee: 'provider-person.maya',
        nextActionOn: '2026-07-24',
        context: 'Project'
      }
    }));
    expect(await screen.findByText('Task Capture preview')).toBeVisible();
    expect(screen.getByText('Task create scope prepared for review')).toBeVisible();
    const effects = screen.getByRole('region', { name: 'Preparation effect boundary' });
    expect(effects).toHaveTextContent('write');
    expect(effects).toHaveTextContent('confirm');
    expect(effects).toHaveTextContent('not executed');
    expect(screen.getByRole('region', { name: 'Proposed change fingerprints' })).toHaveTextContent('crm.records.create');
    expect(screen.getByRole('region', { name: 'Proposed change fingerprints' })).toHaveTextContent('unavailable');
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(screen.queryByText('0 proposed changes · read-only review')).not.toBeInTheDocument();
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('PRIVATE_TASK_UI_SENTINEL');
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('2026-07-24');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('PRIVATE_TASK_UI_SENTINEL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('2026-07-24');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('No authority');
  });

  it('keeps duplicate Task Capture review factual and proposes no create authority', async () => {
    vi.mocked(window.soterStudio.prepareAutomationRun).mockResolvedValueOnce(taskCapturePreparedWorkFixture('duplicate'));
    vi.mocked(window.soterStudio.getPreparedWorkReview).mockResolvedValueOnce({ ok: true, material: taskCaptureReviewFixture('Send launch deck') });
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={taskCaptureWorkflowFixture()} configuration={taskCaptureConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Task title'), 'Send launch deck');
    await userEvent.type(screen.getByLabelText('Project reference'), 'soter-fixture://crm/project/launch');
    await userEvent.selectOptions(screen.getByLabelText('Task context'), 'Project');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    expect(await screen.findByText('An exact-title task candidate exists and must be reviewed instead of silently creating a duplicate.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Proposed change fingerprints' })).not.toBeInTheDocument();
    expect(screen.getByText('0 proposed changes · write not proposed')).toBeVisible();
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(container.querySelector('.operator-confirmation-ceremony button')).not.toBeInTheDocument();
  });

  it('mechanically renders Email coverage, closed actions, exact private joins, and the no-authority stop', async () => {
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'SYNTHETIC_PRIVATE_MAILBOX_QUERY');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.type(screen.getByLabelText('Private focus notes'), 'SYNTHETIC_PRIVATE_FOCUS_NOTE');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.email-triage', configurationName: 'email-triage',
      input: { query: 'SYNTHETIC_PRIVATE_MAILBOX_QUERY', scope: 'triage-drafts-handoffs-digest', focus: 'SYNTHETIC_PRIVATE_FOCUS_NOTE' }
    }));
    await waitFor(() => expect(window.soterStudio.getPreparedWorkDerivedReview).toHaveBeenCalledWith({ workId: 'work.email-triage.ui-test' }));

    const manifest = screen.getByRole('region', { name: 'Prepared review collections' });
    expect(manifest).toHaveTextContent('2 exact collections');
    const collections = container.querySelectorAll('.review-collection');
    expect(collections).toHaveLength(2);
    expect(collections[0].querySelectorAll('.review-row')).toHaveLength(10);
    expect(within(collections[0] as HTMLElement).getByText('15')).toBeVisible();
    expect(within(collections[0] as HTMLElement).getByText('11')).toBeVisible();
    expect(within(collections[0] as HTMLElement).getByText('4')).toBeVisible();
    for (const code of ['NO_ACTIVE_INBOX_MESSAGE_REMOVED', 'RFC822_ALIAS_DUPLICATE_REMOVED', 'SELF_SENT_ONLY_REMOVED', 'ALREADY_TRIAGED_NO_NEWER_REMOVED']) {
      expect(within(collections[0] as HTMLElement).getByText(code)).toBeVisible();
    }
    expect(manifest).toHaveTextContent('2 represented');
    expect(manifest).toHaveTextContent('REPLY_DRAFT_PROPOSED');
    expect(manifest).toHaveTextContent('MEETING_INTAKE_HANDOFF');
    expect(manifest).toHaveTextContent('EMAIL_SEND_PROHIBITED');
    expect(manifest).toHaveTextContent('dispatch · no bound capability');
    expect(collections[0]).not.toHaveTextContent('SYNTHETIC_PRIVATE_MAILBOX_QUERY');
    expect(collections[0]).not.toHaveTextContent('Synthetic triage subject 1');

    await userEvent.click(screen.getAllByText(/Open Thread detail/)[0]);
    expect(await screen.findByText('Synthetic triage subject 1')).toBeVisible();
    expect(screen.getByText('Synthetic normalized summary 1.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Selected private derived review' })).toHaveTextContent('No authority');
    expect(screen.getByRole('region', { name: 'Selected private derived review' })).toHaveTextContent('cannot approve, continue, execute, write, send');
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('SYNTHETIC_PRIVATE_MAILBOX_QUERY');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('SYNTHETIC_PRIVATE_MAILBOX_QUERY');
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(container.querySelector('.operator-confirmation-ceremony button')).not.toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('opens one exact connected Email proposal as a review-only sanitized ledger and selected private folio', async () => {
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));

    await waitFor(() => expect(window.soterStudio.getAutomationProposal).toHaveBeenCalledWith({
      proposalId: 'proposal.email-triage.ui-test',
      configurationName: 'email-triage',
      lockFingerprint: 'sha256:' + '8'.repeat(64)
    }));
    await waitFor(() => expect(window.soterStudio.getAutomationProposalMaterial).toHaveBeenCalledWith({
      proposalId: 'proposal.email-triage.ui-test',
      configurationName: 'email-triage',
      lockFingerprint: 'sha256:' + '8'.repeat(64)
    }));

    const dossier = await screen.findByRole('article', { name: 'Selected Email review-only proposal' });
    expect(screen.queryByRole('region', { name: 'Two-step approval ceremony' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Exact connected subset gate' })).toHaveTextContent('Approval requestnot created');
    expect(dossier).toHaveTextContent('AUTOMATION_PROPOSAL_REVIEW_ONLY');
    expect(dossier).toHaveTextContent('Authority');
    expect(dossier).toHaveTextContent('none');
    expect(dossier).toHaveTextContent('run remains paused');
    const manifest = within(dossier).getByRole('region', { name: 'Automation proposal review collections' });
    expect(manifest).toHaveTextContent('15');
    expect(manifest).toHaveTextContent('11');
    expect(manifest).toHaveTextContent('4');
    expect(manifest).toHaveTextContent('EMAIL_SEND_PROHIBITED');
    expect(within(manifest).getAllByRole('checkbox', { name: /for exact connected scope/ }).length).toBeGreaterThan(0);
    const injectionCode = within(manifest).getAllByText('SUSPECTED_PROMPT_INJECTION')[0];
    const injectionRow = injectionCode.closest('.review-row');
    expect(injectionRow).toHaveTextContent('held');
    expect(injectionRow).toHaveTextContent('no bound capability');
    expect(injectionRow).not.toHaveTextContent('mail.labels.apply');
    expect(within(injectionRow as HTMLElement).queryByRole('checkbox')).not.toBeInTheDocument();

    const privateFolio = within(dossier).getByRole('region', { name: 'Selected proposal private material' });
    expect(privateFolio).toHaveTextContent('AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY');
    await userEvent.click(within(privateFolio).getAllByText(/Open Thread detail/)[0]);
    expect(privateFolio).toHaveTextContent('Synthetic triage subject 1');
    expect(privateFolio).toHaveTextContent('Synthetic normalized summary 1.');
    expect(within(dossier).queryByRole('button', { name: /approve|confirm|continue|retry|execute|write|send/i })).not.toBeInTheDocument();
    expect(manifest).not.toHaveTextContent('Synthetic triage subject 1');
    expect(JSON.stringify(studioFixture())).not.toContain('Synthetic complete draft body for local review');
    expect((await axe.run(container)).violations).toEqual([]);

    await userEvent.clear(screen.getByLabelText('Exact proposal ID'));
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.other');
    expect(screen.queryByRole('article', { name: 'Selected Email review-only proposal' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('Synthetic triage subject 1');
  });

  it('previews one exact label subset through Core before creating the separate approval request', async () => {
    const proposal = emailTriageAutomationProposalFixture();
    const labelAction = proposal.review.collections.flatMap((collection) => collection.rows)
      .flatMap((row) => row.actions).find((action) => action.state === 'proposed' && action.kind === 'label')!;
    const preview = emailTriageProposalConnectedPreviewFixture([labelAction.id]);
    window.soterStudio.previewProposalConnectedBatch = vi.fn().mockResolvedValue({ ok: true, preview });
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), proposal.id);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    await userEvent.click((await screen.findAllByRole('checkbox', { name: /Select Label for exact connected scope/ }))[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Preview exact connected scope' }));

    await waitFor(() => expect(window.soterStudio.previewProposalConnectedBatch).toHaveBeenCalledWith({
      proposalId: proposal.id,
      configurationName: 'email-triage',
      lockFingerprint: 'sha256:' + '8'.repeat(64),
      actionIds: [labelAction.id]
    }));
    const instrument = await screen.findByRole('region', { name: 'Exact connected subset preview' });
    expect(instrument).toHaveTextContent('CONNECTED_BATCH_PREVIEW_ONLY');
    expect(instrument).toHaveTextContent('Provider calls0');
    expect(instrument).toHaveTextContent('External writes0');
    expect(instrument).toHaveTextContent('provider.integration.gmail.mcp');
    expect(instrument).toHaveTextContent('mail.labels.read');
    expect(instrument).toHaveTextContent('MAIL_LABEL_WRITE_AMBIGUOUS');
    expect(instrument).not.toHaveTextContent('gmail-message.synthetic.001');
    expect(instrument).not.toHaveTextContent('AI/Synthetic/needs-you');
    expect(screen.queryByRole('region', { name: 'Two-step approval ceremony' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Request exact approval' }));
    await waitFor(() => expect(window.soterStudio.beginProposalConnectedApproval).toHaveBeenCalledWith({
      proposal: {
        proposalId: proposal.id,
        configurationName: 'email-triage',
        lockFingerprint: 'sha256:' + '8'.repeat(64)
      },
      preview
    }));
    expect(await screen.findByText('Awaiting exact approval')).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Private exact-batch approval review' })).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Selected Email review-only proposal' })).not.toBeInTheDocument();
    expect(window.soterStudio.confirmConnectedApproval).not.toHaveBeenCalled();
    expect(window.soterStudio.startConnectedTransaction).not.toHaveBeenCalled();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('keeps draft subsets blocked and discards hostile connected-preview rejection prose', async () => {
    window.soterStudio.previewProposalConnectedBatch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE',
          message: 'The selected proposal actions do not have one exact connected write and verification provider.'
        }
      })
      .mockRejectedValueOnce(new Error('PRIVATE_CONNECTED_PREVIEW_SENTINEL /Users/operator/.soter/state'));
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Select Draft for exact connected scope/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview exact connected scope' }));
    expect(await screen.findByText('PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The selected proposal actions do not have one exact connected write and verification provider.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request exact approval' })).not.toBeInTheDocument();
    first.unmount();

    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    await userEvent.click((await screen.findAllByRole('checkbox', { name: /Select Label for exact connected scope/ }))[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Preview exact connected scope' }));
    expect(await screen.findByText('PROPOSAL_CONNECTED_BATCH_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The exact connected proposal preview is unavailable.')).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_CONNECTED_PREVIEW_SENTINEL');
    expect(second.container).not.toHaveTextContent('/Users/operator/.soter/state');
    expect(window.soterStudio.beginProposalConnectedApproval).not.toHaveBeenCalled();
  });

  it('suppresses selected proposal values on hostile transport prose and exact binding failure', async () => {
    vi.mocked(window.soterStudio.getAutomationProposal).mockRejectedValueOnce(
      new Error('PRIVATE_PROPOSAL_REJECTION_SENTINEL /Users/operator/.soter/state/automation-proposals')
    );
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    expect(await screen.findByText('AUTOMATION_PROPOSAL_TRANSPORT_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The selected review-only proposal is unavailable.')).toBeVisible();
    expect(first.container).not.toHaveTextContent('PRIVATE_PROPOSAL_REJECTION_SENTINEL');
    expect(first.container).not.toHaveTextContent('/Users/operator/.soter/state/automation-proposals');
    first.unmount();

    const mismatched = emailTriageAutomationProposalMaterialFixture();
    mismatched.proposal.id = 'proposal.email-triage.binding-mismatch';
    mismatched.items[0].fields[0].reviewValue = 'PRIVATE_PROPOSAL_BINDING_SENTINEL';
    window.soterStudio.getAutomationProposalMaterial = vi.fn().mockResolvedValue({ ok: true, material: mismatched });
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    expect(await screen.findByText(/does not bind this exact proposal, decision, Automation, configuration, review contract, and content seal/i)).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_PROPOSAL_BINDING_SENTINEL');
    expect(within(screen.getByRole('region', { name: 'Selected proposal private material' })).queryByRole('button')).not.toBeInTheDocument();
  });

  it('creates an exact review-only Email subset and replaces request order with Core canonical order', async () => {
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));

    const selectable = screen.getAllByRole('checkbox', { name: /Select .+ for review/ });
    expect(selectable).toHaveLength(11);
    expect(screen.queryByRole('checkbox', { name: /Task Review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Meeting Notes Intake/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /None/ })).not.toBeInTheDocument();

    const draft = screen.getByRole('checkbox', { name: 'Select Draft for review' });
    const firstLabel = screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0];
    await userEvent.click(draft);
    await userEvent.click(firstLabel);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only batch (2)' }));

    expect(window.soterStudio.createPreparedReviewBatch).toHaveBeenCalledWith({
      workId: 'work.email-triage.ui-test',
      actionIds: ['action.email.001.draft', 'action.email.001.label']
    });
    await waitFor(() => expect(window.soterStudio.getPreparedReviewBatchMaterial).toHaveBeenCalledWith({
      batchId: emailTriageReviewBatchFixture().id
    }));
    const folio = await screen.findByRole('region', { name: 'Selected review batch private folio' });
    const ordered = folio.querySelectorAll('.selected-batch-actions > li');
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toHaveTextContent('01');
    expect(ordered[0]).toHaveTextContent('Label');
    expect(ordered[1]).toHaveTextContent('02');
    expect(ordered[1]).toHaveTextContent('Draft');
    expect(folio).toHaveTextContent('Synthetic complete draft body for local review. No message has been sent.');
    expect(folio).toHaveTextContent('Exact message IDs');
    expect(folio).toHaveTextContent('Exact label name');
    expect(folio).toHaveTextContent('Exact reply message ID');
    expect(folio).toHaveTextContent('CONNECTED_PLAN_NOT_COMPILED');
    expect(folio).toHaveTextContent('CONNECTED_VERIFICATION_NOT_PROVEN');
    expect(folio).toHaveTextContent('Review-only selection cannot approve, confirm, continue, retry, execute, write, or send.');
    expect(within(folio).queryByRole('button', { name: /approve|confirm|continue|retry|execute|write|send/i })).not.toBeInTheDocument();

    await userEvent.click(within(folio).getByRole('button', { name: 'Compile review-only candidate' }));
    expect(window.soterStudio.createPreparedConnectedPlan).toHaveBeenCalledWith({ batchId: emailTriageReviewBatchFixture().id });
    await waitFor(() => expect(window.soterStudio.getPreparedConnectedPlan).toHaveBeenCalledWith({ planId: emailTriageConnectedPlanFixture().id }));
    const candidate = await screen.findByRole('region', { name: 'Selected compiled candidate private ledger' });
    expect(candidate.querySelectorAll('.compiled-candidate-operations > li')).toHaveLength(2);
    expect(candidate).toHaveTextContent('Executable');
    expect(candidate).toHaveTextContent('no');
    expect(candidate).toHaveTextContent('Authority');
    expect(candidate).toHaveTextContent('none');
    expect(candidate).toHaveTextContent('AI/Synthetic/needs-you');
    expect(candidate).toHaveTextContent('gmail-message.synthetic.001');
    expect(candidate).toHaveTextContent('provider.integration.gmail.mcp');
    expect(candidate).toHaveTextContent('Create Missing Labels');
    expect(candidate).toHaveTextContent('Synthetic complete draft body for local review. No message has been sent.');
    expect(candidate).toHaveTextContent('not declared');
    expect(candidate).toHaveTextContent('CONNECTED_PROVIDER_NOT_DECLARED');
    expect(candidate).toHaveTextContent('CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED');
    expect(candidate).toHaveTextContent('SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE');
    expect(within(candidate).queryByRole('button')).not.toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);

    await userEvent.click(within(folio).getByRole('button', { name: 'End batch review' }));
    expect(screen.queryByRole('region', { name: 'Selected review batch private folio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected compiled candidate private ledger' })).not.toBeInTheDocument();
    expect(screen.getByText('0 of 11 proposed actions selected')).toBeVisible();
  });

  it('withholds compiled candidate values on hostile transport or exact-binding failure', async () => {
    vi.mocked(window.soterStudio.getPreparedConnectedPlan).mockRejectedValueOnce(
      new Error('PRIVATE_CONNECTED_PLAN_TRANSPORT_SENTINEL /Users/operator/.soter/state/prepared-connected-plans')
    );
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only batch (2)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Compile review-only candidate' }));
    expect(await screen.findByText('PREPARED_CONNECTED_PLAN_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private compiled candidate material is unavailable.')).toBeVisible();
    expect(first.container).not.toHaveTextContent('PRIVATE_CONNECTED_PLAN_TRANSPORT_SENTINEL');
    expect(first.container).not.toHaveTextContent('/Users/operator/.soter/state/prepared-connected-plans');
    first.unmount();

    const mismatched = emailTriageConnectedPlanFixture();
    mismatched.source.batchId = 'review-batch.email-triage.binding-mismatch';
    mismatched.operations[0].input.messageIds = ['PRIVATE_CONNECTED_PLAN_BINDING_SENTINEL'];
    window.soterStudio.getPreparedConnectedPlan = vi.fn().mockResolvedValue({ ok: true, plan: mismatched });
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only batch (2)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Compile review-only candidate' }));
    expect(await screen.findByText(/does not bind this exact review batch, work, lock, and source action set/i)).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_CONNECTED_PLAN_BINDING_SENTINEL');
    expect(screen.queryByRole('region', { name: 'Selected compiled candidate private ledger' })).not.toBeInTheDocument();
  });

  it('withholds selected-batch values and hostile transport prose on adapter or binding failure', async () => {
    vi.mocked(window.soterStudio.getPreparedReviewBatchMaterial).mockRejectedValueOnce(
      new Error('PRIVATE_BATCH_TRANSPORT_SENTINEL /Users/operator/.soter/state/prepared-review-batches')
    );
    const { container, unmount } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only batch (2)' }));
    expect(await screen.findByText('PREPARED_REVIEW_BATCH_MATERIAL_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private selected-batch review material is unavailable.')).toBeVisible();
    expect(container).not.toHaveTextContent('PRIVATE_BATCH_TRANSPORT_SENTINEL');
    expect(container).not.toHaveTextContent('/Users/operator/.soter/state/prepared-review-batches');
    unmount();

    const mismatched = emailTriageReviewBatchMaterialFixture();
    mismatched.batch.id = 'review-batch.email-triage.binding-mismatch';
    mismatched.actions[0].proposed.fields[0].reviewValue = 'PRIVATE_BATCH_BINDING_SENTINEL';
    window.soterStudio.getPreparedReviewBatchMaterial = vi.fn().mockResolvedValue({ ok: true, material: mismatched });
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only batch (2)' }));
    expect(await screen.findByText(/does not bind the exact batch, work, source rows, and selected fingerprints/i)).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_BATCH_BINDING_SENTINEL');
  });

  it('withholds derived Email values and hostile transport prose when the selected private read fails', async () => {
    vi.mocked(window.soterStudio.getPreparedWorkDerivedReview).mockRejectedValueOnce(
      new Error('HOSTILE_DERIVED_BODY_SENTINEL /private/mail/body.txt')
    );
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    expect(await screen.findByText('PREPARED_DERIVED_REVIEW_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private derived review material is unavailable for this prepared work.')).toBeVisible();
    expect(container).not.toHaveTextContent('HOSTILE_DERIVED_BODY_SENTINEL');
    expect(container).not.toHaveTextContent('/private/mail/body.txt');
    expect(container).not.toHaveTextContent('Synthetic triage subject 1');
    expect(screen.getByRole('region', { name: 'Prepared review collections' })).toHaveTextContent('15');
  });

  it('mechanically prepares Project Pulse and renders a private stop-before-write dossier', async () => {
    const { container } = render(<App />);
    expect(await screen.findByText('Operator workspace · canonical projection')).toBeVisible();
    expect(screen.getByText('Example only · no authority')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Project reference'), 'project.pulse-risk');
    await userEvent.type(screen.getByLabelText('Operator note'), 'PRIVATE_UI_NOTE_SENTINEL');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      input: { project: 'project.pulse-risk', operatorGoal: 'PRIVATE_UI_NOTE_SENTINEL' }
    }));
    expect(await screen.findByText('Private preparation receipt')).toBeVisible();
    expect(screen.getByText('PREPARATION_READY_FOR_REVIEW')).toBeVisible();
    expect(screen.getByText('Project Pulse preview')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('read');
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('disclosure');
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('completed contained');
    expect(screen.queryByText('Proposed change ledger')).not.toBeInTheDocument();
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(screen.getAllByText('Private value · submitted only to local Core preparation · never returned in inspection').length).toBeGreaterThan(0);
    expect(screen.getByText(/Private inputs originate in this renderer and are sent only to the trusted local Core preparation operation/)).toBeVisible();
    expect(screen.getByText('fingerprinted · raw absent')).toBeVisible();
    expect(await screen.findByText('Private local review')).toBeVisible();
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('PRIVATE_UI_NOTE_SENTINEL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('PRIVATE_UI_NOTE_SENTINEL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('No authority');
  });

  it('keeps the sanitized prepared-work dossier visible when private review material is unavailable', async () => {
    vi.mocked(window.soterStudio.getPreparedWorkReview).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PREPARED_REVIEW_MATERIAL_TAMPERED',
        message: 'Prepared-work review material fingerprint does not match its durable contents.'
      }
    });
    const { container } = render(<App />);
    expect(await screen.findByText('Operator workspace · canonical projection')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Project reference'), 'project.pulse-risk');
    await userEvent.type(screen.getByLabelText('Operator note'), 'PRIVATE_UNAVAILABLE_SENTINEL');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    expect(await screen.findByText('Private preparation receipt')).toBeVisible();
    expect(screen.getByText('PREPARED_REVIEW_MATERIAL_TAMPERED')).toBeVisible();
    expect(screen.getByText('Private values withheld')).toBeVisible();
    expect(screen.getByText(/sanitized prepared-work receipt remains available/i)).toBeVisible();
    expect(container.querySelector('.dossier-private-review')).not.toHaveTextContent('PRIVATE_UNAVAILABLE_SENTINEL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('No authority');
  });

  it('never renders unexpected private-review transport rejection prose', async () => {
    vi.mocked(window.soterStudio.getPreparedWorkReview).mockRejectedValueOnce(
      new Error('HOSTILE_PRIVATE_PATH_SENTINEL /private/user/secrets.json')
    );
    const { container } = render(<App />);
    expect(await screen.findByText('Operator workspace · canonical projection')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Project reference'), 'project.pulse-risk');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    expect(await screen.findByText('PREPARED_REVIEW_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private review material is unavailable for this prepared work.')).toBeVisible();
    expect(container).not.toHaveTextContent('HOSTILE_PRIVATE_PATH_SENTINEL');
    expect(container).not.toHaveTextContent('/private/user/secrets.json');
  });

  it('mechanically prepares Meeting Intake without inventing judgment or approval scope', async () => {
    window.location.hash = '#/operate/automation.meeting-intake';
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Automation Meeting Intake' })).toBeVisible();
    await userEvent.type(screen.getByLabelText('Transcript meeting reference'), 'meeting.fixture-001');
    await userEvent.type(screen.getByLabelText('Recording reference'), 'otter://fixture/meeting.fixture-001');
    await userEvent.type(screen.getByLabelText('Desired outcome'), 'PRIVATE_MEETING_UI_GOAL');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: 'otter://fixture/meeting.fixture-001',
        operatorGoal: 'PRIVATE_MEETING_UI_GOAL'
      }
    }));
    expect(await screen.findByText('Meeting Intake preview')).toBeVisible();
    expect(screen.getByText('Relationships and follow-up candidates require cited judgment')).toBeVisible();
    expect(screen.getByText('Participant identity resolution')).toBeVisible();
    expect(screen.getByText('0 proposed changes · judgment not performed')).toBeVisible();
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(screen.queryByText('Proposed change ledger')).not.toBeInTheDocument();
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('otter://fixture/meeting.fixture-001');
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('PRIVATE_MEETING_UI_GOAL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('otter://fixture/meeting.fixture-001');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('PRIVATE_MEETING_UI_GOAL');
  });

  it('renders nullable fingerprints as unavailable and ignores hostile raw values', async () => {
    const inspection = operatorInspectionFixture();
    Object.assign(inspection.scope.changes[0] as unknown as Record<string, unknown>, {
      before: 'PRIVATE_BEFORE_SENTINEL', after: 'PRIVATE_AFTER_SENTINEL'
    });
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(inspection);
    window.location.hash = `#/operate/${activity.id}`;
    const { container } = render(<App />);
    expect(await screen.findByText('Local private activity')).toBeVisible();
    expect(screen.getAllByText('record.project-pulse').length).toBeGreaterThan(1);
    expect(screen.getAllByText('unavailable').length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent('PRIVATE_BEFORE_SENTINEL');
    expect(container).not.toHaveTextContent('PRIVATE_AFTER_SENTINEL');
  });

  it('performs the exact approval ceremony through the canonical request id', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.location.hash = `#/operate/${activity.id}`;
    const { container } = render(<App />);
    expect(await screen.findByText('Awaiting exact approval')).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Private exact-batch approval review' })).toHaveTextContent('Exact operation review');
    expect(screen.getByRole('region', { name: 'Before review value' })).toHaveTextContent('PRIVATE_APPROVAL_BEFORE_SENTINEL');
    expect(screen.getByRole('region', { name: 'Proposed review value' })).toHaveTextContent('PRIVATE_APPROVAL_PROPOSED_SENTINEL');
    expect(screen.getByText('Private review ends here')).toBeVisible();
    expect(window.soterStudio.getConnectedApprovalReview).toHaveBeenCalledWith({ requestId: 'approval-request.project-pulse.ui-test' });
    const acknowledgement = screen.getByLabelText(/I reviewed the exact lock/i);
    await userEvent.click(acknowledgement);
    await userEvent.click(screen.getByRole('button', { name: 'Approve exact request' }));
    await waitFor(() => expect(window.soterStudio.confirmConnectedApproval).toHaveBeenCalledWith({
      requestId: 'approval-request.project-pulse.ui-test',
      approvalId: 'approval.project-pulse.ui-test',
      confirmed: true,
      reason: 'Approved in Soter Studio after exact-scope review'
    }));
    const accessibility = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
  });

  it('suppresses private approval values when selected-activity bindings do not match', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    snapshot.activity.unshift(activity);
    const material = testConnectedApprovalReview(operatorInspectionFixture());
    material.request.fingerprint = `sha256:${'f'.repeat(64)}`;
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getConnectedApprovalReview = vi.fn().mockResolvedValue({ ok: true, material });
    window.location.hash = `#/operate/${activity.id}`;
    const { container } = render(<App />);
    const folio = await screen.findByRole('status');
    expect(folio).toHaveTextContent('CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID');
    expect(folio).toHaveTextContent('does not match this selected activity');
    expect(container).not.toHaveTextContent('PRIVATE_APPROVAL_BEFORE_SENTINEL');
    expect(container).not.toHaveTextContent('PRIVATE_APPROVAL_PROPOSED_SENTINEL');
    expect(screen.getByLabelText(/I reviewed the exact lock/i)).toBeEnabled();
  });

  it('discards hostile IPC rejection prose at the renderer boundary', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getConnectedApprovalReview = vi.fn().mockRejectedValue(new Error('PRIVATE_APPROVAL_PATH_SENTINEL /Users/operator/.soter/state'));
    window.location.hash = `#/operate/${activity.id}`;
    const { container } = render(<App />);
    const folio = await screen.findByRole('status');
    expect(folio).toHaveTextContent('CONNECTED_APPROVAL_REVIEW_ADAPTER_UNAVAILABLE');
    expect(folio).toHaveTextContent('Private approval review material is unavailable for this selected activity.');
    expect(container).not.toHaveTextContent('PRIVATE_APPROVAL_PATH_SENTINEL');
    expect(container).not.toHaveTextContent('/Users/operator/.soter/state');
  });

  it('renders explicit source absence and drops private material when activity selection ends', async () => {
    const snapshot = studioFixture();
    const workflow = snapshot.workflows.find((item) => item.id === 'automation.project-pulse')!;
    const configuration = snapshot.configurations.find((item) => item.name === 'project-pulse')!;
    const activity = connectedActivityFixture();
    const material = testConnectedApprovalReview(operatorInspectionFixture());
    material.completeness = { state: 'incomplete', reasonCodes: ['SOURCE_CONTEXT_UNAVAILABLE'] };
    material.operations[0].before = {
      state: 'unavailable', reasonCode: 'SOURCE_CONTEXT_UNAVAILABLE', fingerprint: null
    };
    window.soterStudio.getConnectedApprovalReview = vi.fn().mockResolvedValue({ ok: true, material });
    const { container, rerender } = render(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={activity} onChanged={vi.fn()} />);
    expect(await screen.findByText('Source context is unavailable; no value is represented.')).toBeVisible();
    expect(screen.getAllByText('SOURCE_CONTEXT_UNAVAILABLE').length).toBeGreaterThan(0);
    expect(container).toHaveTextContent('PRIVATE_APPROVAL_PROPOSED_SENTINEL');
    rerender(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={null} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Private exact-batch approval review' })).not.toBeInTheDocument());
    expect(container).not.toHaveTextContent('PRIVATE_APPROVAL_PROPOSED_SENTINEL');
  });

  it('renders canonical not-required prior state without inventing a before value', async () => {
    const snapshot = studioFixture();
    const workflow = emailTriageWorkflowFixture();
    const configuration = emailTriageConfigurationFixture();
    const activity = connectedActivityFixture();
    const inspection = operatorInspectionFixture();
    const material = testConnectedApprovalReview(inspection);
    material.operations[0].subject.id = null;
    material.operations[0].before = { state: 'not-required', reasonCode: 'PRIOR_VALUE_NOT_REQUIRED', fingerprint: null };
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(inspection);
    window.soterStudio.getConnectedApprovalReview = vi.fn().mockResolvedValue({ ok: true, material });
    const { container } = render(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={activity} onChanged={vi.fn()} />);
    const before = await screen.findByRole('region', { name: 'Before review value' });
    expect(before).toHaveTextContent('not-required');
    expect(before).toHaveTextContent('PRIOR_VALUE_NOT_REQUIRED');
    expect(before).toHaveTextContent('This operation does not require a prior value; none is represented.');
    expect(before).not.toHaveTextContent('PRIVATE_APPROVAL_BEFORE_SENTINEL');
    expect(container).toHaveTextContent('PRIVATE_APPROVAL_PROPOSED_SENTINEL');
  });

  it('starts only by approval id and never enables continuation from descriptive guidance', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    activity.operatorRef = { requestId: 'approval-request.project-pulse.ui-test', approvalId: 'approval.project-pulse.ui-test', checkpointId: null };
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(operatorInspectionFixture('approved-not-started'));
    window.location.hash = `#/operate/${activity.id}`;
    render(<App />);
    expect(await screen.findByRole('button', { name: 'No executable continuation' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Consume approval + start' }));
    await waitFor(() => expect(window.soterStudio.startConnectedTransaction).toHaveBeenCalledWith({ approvalId: 'approval.project-pulse.ui-test' }));
  });

  it('makes a blocked checkpoint actionable only through its exact read-only continuation request', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    activity.state = 'blocked';
    activity.recoveryId = 'checkpoint.transaction.project-pulse.ui-test';
    activity.operatorRef = { requestId: 'approval-request.project-pulse.ui-test', approvalId: 'approval.project-pulse.ui-test', checkpointId: activity.recoveryId };
    snapshot.activity.unshift(activity);
    const blocked = operatorRecoveryInspectionFixture('blocked');
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(blocked);
    window.soterStudio.prepareConnectedReconciliation = vi.fn().mockResolvedValue(operatorInspectionFixture('running'));
    window.location.hash = `#/operate/${activity.id}`;
    const { container } = render(<App />);
    expect((await screen.findAllByText('RECONCILIATION_AVAILABLE')).length).toBeGreaterThan(1);
    expect(screen.getByRole('region', { name: 'Exact checkpoint recovery' })).toBeVisible();
    expect(screen.getByText('Completed prefix')).toBeVisible();
    expect(screen.getByText('Exact current step')).toBeVisible();
    expect(screen.getByText('Remaining')).toBeVisible();
    expect(screen.getByText('crm.records.read')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Prepare read-only reconciliation' }));
    await waitFor(() => expect(window.soterStudio.prepareConnectedReconciliation).toHaveBeenCalledWith({
      checkpointId: 'checkpoint.transaction.project-pulse.ui-test'
    }));
    const accessibility = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
  });

  it('keeps stale checkpoints unavailable even when descriptive recovery text exists', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    activity.state = 'blocked';
    activity.operatorRef = { requestId: 'approval-request.project-pulse.ui-test', approvalId: 'approval.project-pulse.ui-test', checkpointId: 'checkpoint.transaction.project-pulse.ui-test' };
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(operatorRecoveryInspectionFixture('checkpoint-stale'));
    window.location.hash = `#/operate/${activity.id}`;
    render(<App />);
    expect((await screen.findAllByText('CHECKPOINT_STALE')).length).toBeGreaterThan(1);
    expect(screen.getByText('The exact lock no longer applies.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'No executable continuation' })).toBeDisabled();
    expect(window.soterStudio.prepareConnectedReconciliation).not.toHaveBeenCalled();
  });

  it('keeps verification failure and compensation progress separate', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    activity.state = 'rolling-back';
    activity.operatorRef = { requestId: 'approval-request.project-pulse.ui-test', approvalId: 'approval.project-pulse.ui-test', checkpointId: 'checkpoint.transaction.project-pulse.ui-test' };
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(operatorRecoveryInspectionFixture('rolling-back'));
    window.location.hash = `#/operate/${activity.id}`;
    render(<App />);
    expect(await screen.findByText('READ_AFTER_WRITE_MISMATCH')).toBeVisible();
    expect(screen.getAllByText('restore-prior-fields').length).toBeGreaterThan(0);
    expect(screen.getAllByText('running', { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Continue through configured host' })).toBeDisabled();
  });

  it('mechanically renders the full input control matrix with WCAG semantics', async () => {
    const fields: OperatorInputField[] = [
      { id: 'project', label: 'Project reference', description: 'Exact project identifier.', type: 'reference', required: true, exposure: 'identifier', reference: { subject: 'crm.records.project', authorityRole: 'instance' }, examples: ['project.fixture-001'] },
      { id: 'thread', label: 'Email thread', description: 'Private provider reference.', type: 'uri', required: true, exposure: 'private' },
      { id: 'scope', label: 'Task scope', description: 'Declared task boundary.', type: 'enum', required: true, exposure: 'identifier', options: ['open', 'all'] },
      { id: 'approved', label: 'Scope acknowledged', description: 'Required acknowledgement.', type: 'boolean', required: true, exposure: 'identifier' },
      { id: 'due', label: 'Due date', description: 'Requested completion date.', type: 'date', required: false, exposure: 'identifier' },
      { id: 'notes', label: 'Optional notes', description: 'Private operator intent.', type: 'string', required: false, exposure: 'private', constraints: { minLength: 3, maxLength: 120 } }
    ];
    const { container } = render(<form>{fields.map((field) => <OperatorInputControl key={field.id} field={field} value={field.type === 'boolean' ? false : ''} onChange={vi.fn()} />)}</form>);
    expect(screen.getByLabelText('Project reference')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Email thread')).toHaveAttribute('inputmode', 'url');
    expect(screen.getByLabelText('Task scope')).toBeRequired();
    expect(screen.getByLabelText('Scope acknowledged')).toHaveAttribute('type', 'checkbox');
    expect(screen.getByLabelText('Due date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Optional notes').tagName).toBe('TEXTAREA');
    const accessibility = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
  });
});

function testConnectedApprovalReview(inspection: OperatorInspection): ConnectedApprovalReviewMaterial {
  const fp = (digit: string) => `sha256:${digit.repeat(64)}`;
  return {
    $contract: 'soter://contracts/connected-approval-review-material/v1',
    contractVersion: '1.0.0',
    fingerprint: fp('a'),
    request: {
      id: inspection.approval.request.id,
      fingerprint: inspection.approval.request.fingerprint,
      createdAt: inspection.approval.request.requestedAt,
      expiresAt: inspection.approval.request.expiresAt,
      reason: 'Review one exact contained CRM update before the separate actor decision.'
    },
    configuration: {
      path: inspection.configuration.path,
      lockPath: inspection.configuration.lockPath,
      lockFingerprint: inspection.configuration.lockFingerprint,
      graphFingerprint: inspection.configuration.graphFingerprint,
      host: inspection.configuration.host,
      applicability: {
        state: inspection.configuration.applicability.state,
        expectedLockFingerprint: inspection.configuration.applicability.expectedLockFingerprint,
        observedLockFingerprint: inspection.configuration.applicability.observedLockFingerprint,
        reasonCode: inspection.configuration.applicability.reasonCode as ConnectedApprovalReviewMaterial['configuration']['applicability']['reasonCode']
      }
    },
    run: { id: inspection.activity.runId, fingerprint: fp('b') },
    changeSet: { id: inspection.scope.changeSet.id, documentFingerprint: inspection.scope.changeSet.fingerprint, scopeFingerprint: fp('c') },
    batch: { id: inspection.scope.batch.id, documentFingerprint: inspection.scope.batch.fingerprint, scopeFingerprint: fp('d') },
    effects: ['write'],
    completeness: { state: 'complete', reasonCodes: [] },
    operations: [{
      id: inspection.scope.changes[0].id,
      sequence: 1,
      capability: 'crm.records.update',
      authority: 'authority.crm.instance',
      reason: 'Update the exact portable project record after human review.',
      changeSetOperationFingerprint: fp('e'),
      batchOperationFingerprint: fp('f'),
      inputFingerprint: fp('1'),
      subject: { kind: 'portable-resource', type: 'project', id: inspection.scope.changes[0].recordId },
      before: { state: 'provided', reasonCode: 'SOURCE_CONTEXT_BOUND', fingerprint: fp('2'), reviewValue: { status: 'PRIVATE_APPROVAL_BEFORE_SENTINEL', risk: 'watch' } },
      after: { state: 'provided', fingerprint: fp('3'), reviewValue: { status: 'PRIVATE_APPROVAL_PROPOSED_SENTINEL', risk: 'at-risk' } },
      precondition: { fingerprint: fp('4'), reviewValue: { expectedStatus: 'PRIVATE_APPROVAL_BEFORE_SENTINEL' } },
      verification: { kind: 'read-after-write', expectedFingerprint: fp('5'), contentFingerprint: null },
      recovery: { mode: 'restore-prior-fields', reason: 'Restore the exact prior portable fields if verification fails.' },
      operationFingerprint: fp('6')
    }],
    privacy: {
      scope: 'private-local-approval-review',
      authority: 'none',
      projection: 'selected-activity-only',
      providerArgumentsIncluded: false,
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false,
      approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false
    }
  };
}
