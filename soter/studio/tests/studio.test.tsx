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
import reviewOnlyCandidatePreviewSchema from '../../contracts/review-only-candidate-preview.schema.json';
import reviewOnlyCandidateSelectionMaterialSchema from '../../contracts/review-only-candidate-selection-material.schema.json';
import reviewOnlyCandidateSelectionSchema from '../../contracts/review-only-candidate-selection.schema.json';
import preparedWorkDerivedReviewSchema from '../../contracts/prepared-work-derived-review-material.schema.json';
import preparedWorkReviewSchema from '../../contracts/prepared-work-review-material.schema.json';
import preparedWorkSchema from '../../contracts/prepared-work.schema.json';
import workspaceInspectionSchema from '../../contracts/workspace-inspection.schema.json';
import emailDerivedReviewDefinition from '../../automations/email-triage/derived-review.json';
// @ts-expect-error The canonical verifier is a checked JavaScript module without a declaration file.
import { validateJsonSchema } from '../../kernel/verify.mjs';

import { App } from '../renderer/src/App';
import { AutomationProposalDossier } from '../renderer/src/components/AutomationProposalDossier';
import { CatalogNav } from '../renderer/src/components/CatalogNav';
import { ConfigView } from '../renderer/src/components/ConfigView';
import { DistributionView } from '../renderer/src/components/DistributionView';
import { HostRealizationDesk } from '../renderer/src/components/HostRealizationDesk';
import { PackInstallDesk } from '../renderer/src/components/PackInstallDesk';
import { OperatorInputControl } from '../renderer/src/components/OperatorInputControl';
import { OperatorView } from '../renderer/src/components/OperatorView';
import { previewTitle } from '../renderer/src/components/PreparedWorkDossier';
import { RunsView } from '../renderer/src/components/RunsView';
import { WorkflowView } from '../renderer/src/components/WorkflowView';
import type { Activity, ConnectedApprovalReviewMaterial, OperatorInputField, OperatorInspection } from '../renderer/src/types';
import { bundleInspectionFixture, configurationChangeInspectionFixture, configurationPreviewFixture, connectedAcquisitionPreparedWorkFixture, connectedAcquisitionReviewFixture, connectedActivityFixture, emailConnectedAcquisitionActivityFixture, emailTriageAutomationProposalFixture, emailTriageAutomationProposalMaterialFixture, emailTriageCandidatePreviewFixture, emailTriageCandidateSelectionFixture, emailTriageCandidateSelectionMaterialFixture, emailTriageConfigurationFixture, emailTriageDerivedReviewFixture, emailTriagePreparedWorkFixture, emailTriageProposalConnectedPreviewFixture, emailTriageReviewFixture, emailTriageWorkflowFixture, hostRealizationInspectionFixture, meetingIntakeHeldAutomationProposalFixture, meetingIntakePreparedWorkFixture, operatorInspectionFixture, operatorRecoveryInspectionFixture, packInstallInspectionFixture, packReleaseInspectionFixture, preparedWorkFixture, preparedWorkReviewFixture, projectCaptureAutomationProposalFixture, projectCaptureAutomationProposalMaterialFixture, projectCaptureConfigurationFixture, projectCaptureWorkflowFixture, projectPageReconciliationAutomationProposalFixture, projectPageReconciliationAutomationProposalMaterialFixture, projectPageReconciliationConfigurationFixture, projectPageReconciliationWorkflowFixture, projectPulseDerivedReviewFixture, studioFixture, taskCaptureConfigurationFixture, taskCapturePreparedWorkFixture, taskCaptureReviewFixture, taskCaptureWorkflowFixture } from './fixture';

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
    getPreparedWorkReview: vi.fn().mockImplementation((request: { workId: string }) => Promise.resolve({
      ok: true as const,
      material: request.workId.includes('connected-acquisition')
        ? connectedAcquisitionReviewFixture()
        : request.workId.includes('email-triage')
          ? emailTriageReviewFixture()
          : request.workId.includes('task-capture')
            ? taskCaptureReviewFixture()
            : preparedWorkReviewFixture(request.workId)
    })),
    getPreparedWorkDerivedReview: vi.fn().mockImplementation((request: { workId: string }) => Promise.resolve(request.workId.includes('email-triage')
      ? { ok: true as const, material: emailTriageDerivedReviewFixture() }
      : request.workId.includes('project-pulse')
        ? { ok: true as const, material: projectPulseDerivedReviewFixture() }
      : { ok: false as const, error: { code: 'PREPARED_DERIVED_REVIEW_MATERIAL_MISSING', message: 'Private derived review material is unavailable for this prepared work.' } })),
    createReviewOnlyCandidateSelection: vi.fn().mockResolvedValue({ ok: true as const, selection: emailTriageCandidateSelectionFixture() }),
    getReviewOnlyCandidateSelectionMaterial: vi.fn().mockResolvedValue({ ok: true as const, material: emailTriageCandidateSelectionMaterialFixture() }),
    createReviewOnlyCandidatePreview: vi.fn().mockResolvedValue({ ok: true as const, preview: emailTriageCandidatePreviewFixture() }),
    getReviewOnlyCandidatePreview: vi.fn().mockResolvedValue({ ok: true as const, preview: emailTriageCandidatePreviewFixture() }),
    getAutomationProposal: vi.fn().mockResolvedValue({ ok: true as const, proposal: emailTriageAutomationProposalFixture() }),
    getAutomationProposalMaterial: vi.fn().mockResolvedValue({ ok: true as const, material: emailTriageAutomationProposalMaterialFixture() }),
    previewProposalConnectedBatch: vi.fn().mockResolvedValue({ ok: true as const, preview: emailTriageProposalConnectedPreviewFixture() }),
    beginProposalConnectedApproval: vi.fn().mockResolvedValue({ ok: true as const, inspection: operatorInspectionFixture() }),
    getConnectedApprovalReview: vi.fn().mockResolvedValue({ ok: true as const, material: testConnectedApprovalReview(operatorInspectionFixture()) }),
    prepareAutomationRun: vi.fn().mockImplementation((request: { automationId: string; preparationMode: string }) => Promise.resolve(
      request.preparationMode === 'connected-acquisition'
        ? connectedAcquisitionPreparedWorkFixture()
        : request.automationId === 'automation.email-triage'
          ? emailTriagePreparedWorkFixture()
          : request.automationId === 'automation.task-capture'
            ? taskCapturePreparedWorkFixture()
            : request.automationId === 'automation.meeting-intake'
              ? meetingIntakePreparedWorkFixture()
              : preparedWorkFixture()
    )),
    confirmConnectedApproval: vi.fn().mockResolvedValue({ ok: true as const, inspection: operatorInspectionFixture('approved-not-started') }),
    startConnectedTransaction: vi.fn().mockResolvedValue({ ok: true as const, inspection: operatorInspectionFixture('running') }),
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

  it('keeps Meeting Intake held without selection or authority controls', async () => {
    const snapshot = studioFixture();
    const meetingWorkflow = snapshot.workflows.find((workflow) => workflow.id === 'automation.meeting-intake')!;
    const meetingConfiguration = snapshot.configurations.find((configuration) => configuration.name === 'meeting-intake')!;
    expect(meetingWorkflow.effects).toEqual(['read', 'disclosure']);
    expect(meetingWorkflow.requiredCapabilities).not.toContain('meetings.records.create');
    expect(meetingWorkflow.requiredCapabilities).not.toContain('tasks.records.update');
    expect(meetingWorkflow.scenarios.every((scenario) => scenario.execution === null)).toBe(true);
    expect(meetingConfiguration.bindings.flatMap((binding) => binding.effects)).not.toContain('write');
    expect(meetingConfiguration.effectPolicies.find((policy) => policy.effect === 'write')).toMatchObject({
      mode: 'confirm'
    });

    for (const [proposal, reasonCodes] of [
      [meetingIntakeHeldAutomationProposalFixture(), ['COMPLETE_MEETING_READBACK_UNAVAILABLE', 'MEETING_UNSUPPORTED_EFFECTS_UNAVAILABLE']]
    ] as const) {
      expect(validateJsonSchema(proposal, automationProposalSchema)).toEqual([]);
      const rendered = render(
        <AutomationProposalDossier
          proposal={proposal}
          material={null}
          error={null}
          configurationName={proposal.automation.id.slice('automation.'.length)}
          lockFingerprint={proposal.configurationLockFingerprint}
          selectedActionIds={[]}
          selectionDisabled={false}
          connectedPreview={null}
          onToggleAction={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(screen.getByLabelText('Held proposal boundary')).toHaveTextContent('0 proposed actions');
      for (const reasonCode of reasonCodes) {
        expect(screen.getAllByText(reasonCode).length).toBeGreaterThan(0);
      }
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByText('Preview exact connected scope')).not.toBeInTheDocument();
      expect((await axe.run(rendered.container)).violations).toEqual([]);
      rendered.unmount();
    }
  });

  it('routes exact Project Capture proposals through the generic selected-proposal desk', async () => {
    const proposal = projectCaptureAutomationProposalFixture();
    const material = projectCaptureAutomationProposalMaterialFixture();
    window.soterStudio.getAutomationProposal = vi.fn().mockResolvedValue({ ok: true, proposal });
    window.soterStudio.getAutomationProposalMaterial = vi.fn().mockResolvedValue({ ok: true, material });
    const rendered = render(
      <OperatorView
        snapshot={studioFixture()}
        workflow={projectCaptureWorkflowFixture()}
        configuration={projectCaptureConfigurationFixture()}
        initialActivity={null}
      />
    );

    expect(screen.getByRole('region', { name: 'Exact Project Capture proposal access' })).toBeVisible();
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), proposal.id);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));

    const request = {
      proposalId: proposal.id,
      configurationName: 'project-capture',
      lockFingerprint: proposal.configurationLockFingerprint
    };
    await waitFor(() => expect(window.soterStudio.getAutomationProposal).toHaveBeenCalledWith(request));
    await waitFor(() => expect(window.soterStudio.getAutomationProposalMaterial).toHaveBeenCalledWith(request));
    const dossier = await screen.findByRole('article', { name: 'Selected Project capture review-only proposal' });
    expect(validateJsonSchema(proposal, automationProposalSchema)).toEqual([]);
    expect(validateJsonSchema(material, automationProposalMaterialSchema)).toEqual([]);
    expect(dossier).toHaveTextContent('1 selectable proposed actions');
    expect(dossier).toHaveTextContent('Connected Project body read-back');
    expect(dossier).toHaveTextContent('exact-fields-and-body');
    expect(dossier).not.toHaveTextContent('COMPLETE_PROJECT_READBACK_UNAVAILABLE');
    const selectable = within(dossier).getByRole('checkbox', { name: 'Select Project create for exact connected scope' });
    await userEvent.click(selectable);
    expect(within(dossier).getByLabelText('1 selected actions')).toBeVisible();
    const privateFolio = within(dossier).getByRole('region', { name: 'Selected proposal private material' });
    expect(dossier.querySelector('.proposal-fact-ledger')).not.toHaveTextContent('Private Project candidate body.');
    await userEvent.click(within(privateFolio).getByText(/Open Project create detail/));
    expect(privateFolio).toHaveTextContent('Private Project candidate body.');
    expect(screen.queryByRole('region', { name: 'Two-step approval ceremony' })).not.toBeInTheDocument();
    expect((await axe.run(rendered.container)).violations).toEqual([]);
  });

  it('routes exact Project Page Reconciliation proposals without creating independent authority', async () => {
    const proposal = projectPageReconciliationAutomationProposalFixture();
    const material = projectPageReconciliationAutomationProposalMaterialFixture();
    window.soterStudio.getAutomationProposal = vi.fn().mockResolvedValue({ ok: true, proposal });
    window.soterStudio.getAutomationProposalMaterial = vi.fn().mockResolvedValue({ ok: true, material });
    const rendered = render(
      <OperatorView
        snapshot={studioFixture()}
        workflow={projectPageReconciliationWorkflowFixture()}
        configuration={projectPageReconciliationConfigurationFixture()}
        initialActivity={null}
      />
    );

    expect(screen.getByRole('region', { name: 'Exact Project Page Reconciliation proposal access' })).toBeVisible();
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), proposal.id);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));

    const request = {
      proposalId: proposal.id,
      configurationName: 'project-page-reconciliation',
      lockFingerprint: proposal.configurationLockFingerprint
    };
    await waitFor(() => expect(window.soterStudio.getAutomationProposal).toHaveBeenCalledWith(request));
    await waitFor(() => expect(window.soterStudio.getAutomationProposalMaterial).toHaveBeenCalledWith(request));
    const dossier = await screen.findByRole('article', { name: 'Selected Project page reconciliation review-only proposal' });
    expect(validateJsonSchema(proposal, automationProposalSchema)).toEqual([]);
    expect(validateJsonSchema(material, automationProposalMaterialSchema)).toEqual([]);
    expect(dossier).toHaveTextContent('2 selectable proposed actions');
    expect(dossier).toHaveTextContent('sequential-non-atomic');
    expect(dossier).toHaveTextContent('PROJECT_PROPERTIES_UPDATE_READY_FOR_REVIEW');
    expect(dossier).toHaveTextContent('PROJECT_BODY_UPDATE_READY_FOR_REVIEW');
    expect(dossier.querySelector('.proposal-fact-ledger')).not.toHaveTextContent('Launch is active.');
    const selectors = within(dossier).getAllByRole('checkbox', { name: /Select .* for exact connected scope/ });
    expect(selectors).toHaveLength(2);
    await userEvent.click(selectors[0]);
    await userEvent.click(selectors[1]);
    expect(within(dossier).getByLabelText('2 selected actions')).toBeVisible();
    const privateFolio = within(dossier).getByRole('region', { name: 'Selected proposal private material' });
    await userEvent.click(within(privateFolio).getByText(/Open Project body update detail/));
    expect(privateFolio).toHaveTextContent('Launch is active.');
    expect(screen.queryByRole('region', { name: 'Two-step approval ceremony' })).not.toBeInTheDocument();
    expect((await axe.run(rendered.container)).violations).toEqual([]);
  });

  it('does not infer a generic Notion proposal route for Project Page Reconciliation', () => {
    const rendered = render(
      <OperatorView
        snapshot={studioFixture()}
        workflow={projectPageReconciliationWorkflowFixture()}
        configuration={projectCaptureConfigurationFixture()}
        initialActivity={null}
      />
    );

    expect(screen.queryByRole('region', { name: /Exact Project Page Reconciliation proposal access/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Exact proposal ID')).not.toBeInTheDocument();
    expect(window.soterStudio.getAutomationProposal).not.toHaveBeenCalled();
    expect(rendered.container).not.toHaveTextContent('Launch is active.');
  });

  it('rejects a proposal whose Automation does not match the exact selected route', async () => {
    const workflow = projectCaptureWorkflowFixture();
    const configuration = projectCaptureConfigurationFixture();
    const rendered = render(
      <OperatorView
        snapshot={studioFixture()}
        workflow={workflow}
        configuration={configuration}
        initialActivity={null}
      />
    );
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));

    expect(await screen.findByText('AUTOMATION_PROPOSAL_BINDING_INVALID')).toBeVisible();
    expect(screen.getByText('The selected review-only proposal is unavailable.')).toBeVisible();
    expect(window.soterStudio.getAutomationProposalMaterial).not.toHaveBeenCalled();
    expect(screen.queryByRole('article', { name: /Selected Email triage review-only proposal/ })).not.toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent('Synthetic triage subject 1');
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
    expect(validateJsonSchema(configurationChangeInspectionFixture('reserved'), configurationChangeInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(configurationChangeInspectionFixture('reserved-prepared'), configurationChangeInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(configurationChangeInspectionFixture('started'), configurationChangeInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(configurationChangeInspectionFixture('completed'), configurationChangeInspectionSchema)).toEqual([]);
    const needsAttentionInspection = configurationChangeInspectionFixture('needs-attention');
    expect(validateJsonSchema(needsAttentionInspection, configurationChangeInspectionSchema)).toEqual([]);
    expect(needsAttentionInspection.resume).toEqual({
      classification: 'requires-review',
      reasonCode: 'CONFIGURATION_CHECKPOINT_REQUIRES_REVIEW',
      reason: 'The exact durable configuration checkpoint requires local operator review.',
      permittedNextAction: 'inspect-checkpoint'
    });
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
    expect(window.soterStudio.beginConfigurationChangeRequest).toHaveBeenCalledWith({
      planId: 'configuration-change-plan.meeting-intake.ui-test',
      reason: 'Review this exact private configuration activation or update and its fingerprint-only scope.'
    });
    expect(await screen.findByText('Confirmation records the local actor decision. It does not start or write.')).toBeVisible();
    expect(window.soterStudio.confirmConfigurationChangeRequest).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText('I reviewed this exact fingerprint-only scope.'));
    await user.click(screen.getByRole('button', { name: 'Confirm exact request' }));
    expect(await screen.findByText('Reserve this confirmation once into one deterministic checkpoint. No desired file is changed yet.')).toBeVisible();
    expect(window.soterStudio.startConfigurationChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reserve one-time start' }));
    expect(await screen.findByRole('button', { name: 'Apply exact checkpoint' })).toBeDisabled();
    expect(screen.getByText('Execution creates or replaces the desired configuration and its private active lock, then resolves and verifies both.')).toBeVisible();
    expect(window.soterStudio.executeConfigurationChange).not.toHaveBeenCalled();
    expect(screen.getByText('Core-derived guidance · not authority')).toBeVisible();
    expect(screen.getAllByText('No provider calls').length).toBeGreaterThan(0);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it.each(['reserved', 'reserved-prepared'] as const)('resumes the exact %s configuration start without reconstructing authority', async (stage) => {
    const user = userEvent.setup();
    const snapshot = studioFixture();
    const configuration = snapshot.configurations.find((item) => item.name === 'meeting-intake')!;
    const reservedInspection = configurationChangeInspectionFixture(stage);
    window.soterStudio.prepareConfigurationChange = vi.fn().mockResolvedValue({ ok: true as const, inspection: reservedInspection });
    render(<ConfigView snapshot={snapshot} configuration={configuration} />);

    fireEvent.change(await screen.findByLabelText('Complete private candidate'), { target: { value: JSON.stringify({
      $contract: 'soter://contracts/configuration/v1',
      name: configuration.name
    }) } });
    await user.click(screen.getByRole('button', { name: 'Seal exact private plan' }));

    const resume = await screen.findByRole('button', { name: 'Resume exact reserved start' });
    expect(resume).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reserve one-time start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply exact checkpoint' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('/private/target/root');
    await user.click(resume);

    expect(window.soterStudio.startConfigurationChange).toHaveBeenCalledWith({
      confirmationId: reservedInspection.confirmation!.id,
      checkpointId: reservedInspection.consumption!.checkpointId
    });
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
    expect(screen.getByText('.codex/obsolete-tools.json')).toBeVisible();
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

  it('renders current scenario behavior and evidence', () => {
    const snapshot = studioFixture();
    const workflows = [
      ...snapshot.workflows,
      taskCaptureWorkflowFixture(),
      emailTriageWorkflowFixture()
    ];
    expect(workflows.flatMap((workflow) => workflow.scenarios).length).toBeGreaterThan(0);

    const workflow = snapshot.workflows.find((item) => item.id === 'automation.meeting-intake')!;
    const configuration = snapshot.configurations.find((item) => item.name === 'meeting-intake')!;
    const { container } = render(<WorkflowView workflow={workflow} configuration={configuration} />);

    fireEvent.click(container.querySelector('.scenario-row > summary')!);
    expect(screen.getByText('Expected outcomes')).toBeVisible();
    expect(screen.getByText('Invariants')).toBeVisible();
    expect(screen.getByText('Required evidence')).toBeVisible();
  });

  it('renders canonical host incompatibility facts without inventing a fallback', async () => {
    const workflow = structuredClone(studioFixture().workflows[1]);
    workflow.id = 'automation.slack-conversation-review';
    workflow.label = 'Automation Slack Conversation Review';
    workflow.hostCompatibility = {
      claude: {
        state: 'unavailable',
        reasonCode: 'STRUCTURED_RESPONSE_PROFILE_UNAVAILABLE',
        reason: 'The declared Claude Slack route does not expose a closed mechanically normalizable message and thread response profile.'
      },
      codex: { state: 'compatible' }
    };
    const { container } = render(
      <WorkflowView workflow={workflow} configuration={null} />
    );

    const compatibility = screen.getByRole('region', {
      name: 'Workflow host compatibility'
    });
    expect(compatibility).toHaveTextContent('codex');
    expect(compatibility).toHaveTextContent('claude unavailable');
    expect(compatibility).toHaveTextContent('STRUCTURED_RESPONSE_PROFILE_UNAVAILABLE');
    expect(within(compatibility).queryByRole('button')).not.toBeInTheDocument();
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
    expect(validateJsonSchema(connectedAcquisitionPreparedWorkFixture(), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriagePreparedWorkFixture(), preparedWorkSchema)).toEqual([]);
    expect(validateJsonSchema(preparedWorkReviewFixture(), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(preparedWorkReviewFixture('work.meeting-intake.ui-test'), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(taskCaptureReviewFixture(), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageReviewFixture(), preparedWorkReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailDerivedReviewDefinition, automationDerivedReviewSchema)).toEqual([]);
    expect(validateJsonSchema(projectPulseDerivedReviewFixture(), preparedWorkDerivedReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageDerivedReviewFixture(), preparedWorkDerivedReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageCandidateSelectionFixture(), reviewOnlyCandidateSelectionSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageCandidateSelectionMaterialFixture(), reviewOnlyCandidateSelectionMaterialSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageCandidatePreviewFixture(), reviewOnlyCandidatePreviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageAutomationProposalFixture().review, automationReviewSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageAutomationProposalFixture(), automationProposalSchema)).toEqual([]);
    expect(validateJsonSchema(emailTriageAutomationProposalMaterialFixture(), automationProposalMaterialSchema)).toEqual([]);
    const connectedPreview = emailTriageProposalConnectedPreviewFixture();
    expect(validateJsonSchema(connectedPreview.changeSet, connectedChangeSetV2Schema)).toEqual([]);
    expect(validateJsonSchema(connectedPreview.batch, connectedOperationBatchV2Schema)).toEqual([]);
    const labelActionId = emailTriageCandidateSelectionFixture().actions.find((action) => action.kind === 'label')!.id;
    const labelOnlyPreview = emailTriageCandidatePreviewFixture([labelActionId]);
    expect(validateJsonSchema(labelOnlyPreview, reviewOnlyCandidatePreviewSchema)).toEqual([]);
    expect(labelOnlyPreview.operations).toHaveLength(1);
    expect(labelOnlyPreview.operations[0].provider).toEqual({
      pack: 'integration.gmail',
      connectedImplementation: 'provider.integration.gmail.mcp',
      version: '1.0.0'
    });
    expect(labelOnlyPreview.operations[0].precondition).toEqual({ kind: 'none', capability: null, input: null, inputFingerprint: null, expectation: null });
    expect(labelOnlyPreview.operations[0].review?.before).toEqual({ state: 'not-required', reasonCode: 'PRIOR_VALUE_NOT_REQUIRED', fingerprint: null });
    expect(labelOnlyPreview.operations[0].input).toEqual({
      messageIds: ['gmail-message.synthetic.001'],
      addLabelNames: ['AI/Synthetic/needs-you'],
      removeLabelNames: [],
      createMissingLabels: false
    });
    expect(labelOnlyPreview.operations[0].input).not.toHaveProperty('idempotencyKey');
    expect(labelOnlyPreview.operations[0].verification.input).toEqual({
      messageIds: ['gmail-message.synthetic.001'],
      labelNames: ['AI/Synthetic/needs-you'],
      maximumMessages: 1
    });
    expect(labelOnlyPreview.blockers).not.toContain('CONNECTED_PROVIDER_NOT_DECLARED');
    expect(labelOnlyPreview.blockers).toEqual([
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ]);
    expect(validateJsonSchema(operatorInspectionFixture(), operatorInspectionSchema)).toEqual([]);
    expect(validateJsonSchema(testConnectedApprovalReview(operatorInspectionFixture()), connectedApprovalReviewSchema)).toEqual([]);
    for (const state of ['blocked', 'checkpoint-stale', 'verification-failed', 'basis-unavailable'] as const) {
      expect(validateJsonSchema(operatorRecoveryInspectionFixture(state), operatorInspectionSchema)).toEqual([]);
    }
    const impossibleRollback = structuredClone(operatorInspectionFixture('running'));
    (impossibleRollback.activity as { workState: string }).workState = 'rolling-back';
    expect(validateJsonSchema(impossibleRollback, operatorInspectionSchema).length).toBeGreaterThan(0);
    const impossibleCompensation = structuredClone(operatorInspectionFixture('running'));
    (impossibleCompensation.compensation as { state: string }).state = 'running';
    expect(validateJsonSchema(impossibleCompensation, operatorInspectionSchema).length).toBeGreaterThan(0);
    const missingBasis = structuredClone(operatorInspectionFixture('running')) as unknown as {
      configuration: { configurationBasis?: string };
    };
    delete missingBasis.configuration.configurationBasis;
    expect(validateJsonSchema(missingBasis, operatorInspectionSchema).length).toBeGreaterThan(0);
    const hostileContainedContinuation = structuredClone(operatorInspectionFixture('running'));
    hostileContainedContinuation.configuration.configurationBasis = 'tracked-contained';
    expect(validateJsonSchema(hostileContainedContinuation, operatorInspectionSchema).length).toBeGreaterThan(0);
  });

  it('stages connected acquisition only from the declared private-active mode and renders no review or execution authority', async () => {
    const workflow = taskCaptureWorkflowFixture();
    workflow.configurationBasis = 'private-active';
    const configuration = taskCaptureConfigurationFixture();
    configuration.configurationBasis = 'private-active';
    const { container } = render(
      <OperatorView snapshot={studioFixture()} workflow={workflow} configuration={configuration} initialActivity={null} />
    );

    await userEvent.type(screen.getByLabelText('Task title'), 'PRIVATE_TASK_UI_SENTINEL');
    await userEvent.type(screen.getByLabelText('Project reference'), 'project.connected-test');
    await userEvent.click(screen.getByRole('button', { name: 'Stage connected acquisition' }));

    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        title: 'PRIVATE_TASK_UI_SENTINEL',
        project: 'project.connected-test'
      }
    }));

    const dossier = await screen.findByRole('region', { name: 'Prepared work dossier' });
    expect(within(dossier).getByRole('region', { name: 'Connected acquisition staging boundary' })).toHaveTextContent('Staged input + lock');
    expect(dossier).toHaveTextContent('No connected acquisition has run');
    expect(dossier).toHaveTextContent('no provider call, acquired context, approval, continuation request, readiness, or execution authority');
    expect(within(dossier).getAllByText('staged for acquisition').length).toBeGreaterThan(0);
    expect(within(dossier).queryByText('ready for review', { exact: false })).not.toBeInTheDocument();
    expect(within(dossier).queryByText('approved', { exact: false })).not.toBeInTheDocument();
    expect(within(dossier).queryByRole('region', { name: 'Contained context acquisition plan' })).not.toBeInTheDocument();
    expect(within(dossier).queryByRole('region', { name: 'Proposed change fingerprints' })).not.toBeInTheDocument();
    expect(within(dossier).queryByRole('button', { name: /approve|confirm|continue|execute|start|retry/i })).not.toBeInTheDocument();
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('PRIVATE_TASK_UI_SENTINEL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('PRIVATE_TASK_UI_SENTINEL');
  });

  it('does not infer connected staging from a private configuration or send it from tracked-contained work', async () => {
    const trackedWorkflow = taskCaptureWorkflowFixture();
    const trackedConfiguration = taskCaptureConfigurationFixture();
    const first = render(
      <OperatorView snapshot={studioFixture()} workflow={trackedWorkflow} configuration={trackedConfiguration} initialActivity={null} />
    );
    const trackedStage = screen.getByRole('button', { name: 'Stage connected acquisition' });
    expect(trackedStage).toBeDisabled();
    await userEvent.click(trackedStage);
    expect(window.soterStudio.prepareAutomationRun).not.toHaveBeenCalled();
    first.unmount();

    const unavailableWorkflow = taskCaptureWorkflowFixture();
    unavailableWorkflow.configurationBasis = 'private-active';
    unavailableWorkflow.operator!.preparation.modes = unavailableWorkflow.operator!.preparation.modes
      .filter((mode) => mode.id !== 'connected-acquisition');
    const privateConfiguration = taskCaptureConfigurationFixture();
    privateConfiguration.configurationBasis = 'private-active';
    const second = render(
      <OperatorView snapshot={studioFixture()} workflow={unavailableWorkflow} configuration={privateConfiguration} initialActivity={null} />
    );
    expect(screen.queryByRole('button', { name: 'Stage connected acquisition' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare contained run' })).toBeEnabled();
    expect(window.soterStudio.prepareAutomationRun).not.toHaveBeenCalled();
    second.unmount();

    const modeUnavailableWorkflow = taskCaptureWorkflowFixture();
    modeUnavailableWorkflow.configurationBasis = 'private-active';
    const unavailableMode = modeUnavailableWorkflow.operator!.preparation.modes
      .find((mode) => mode.id === 'connected-acquisition')!;
    unavailableMode.availability = {
      state: 'unavailable',
      reasonCode: 'CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE',
      reason: 'Current provider routes expose formatted prose instead of a closed response.'
    };
    const unavailableModeView = render(
      <OperatorView
        snapshot={studioFixture()}
        workflow={modeUnavailableWorkflow}
        configuration={privateConfiguration}
        initialActivity={null}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stage connected acquisition' })).not.toBeInTheDocument();
    expect(screen.getByText(/CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE/)).toBeVisible();
    expect(window.soterStudio.prepareAutomationRun).not.toHaveBeenCalled();
    unavailableModeView.unmount();

    const hostileWorkflow = taskCaptureWorkflowFixture();
    hostileWorkflow.configurationBasis = 'private-active';
    const hostileModes = hostileWorkflow.operator!.preparation.modes as unknown as Array<{
      id: string;
      configurationBases: string[];
      resultState: string;
      boundary: string;
    }>;
    const hostileConnected = hostileModes.find((mode) => mode.id === 'connected-acquisition')!;
    hostileConnected.configurationBases = ['tracked-contained'];
    hostileConnected.resultState = 'ready-for-review';
    render(
      <OperatorView snapshot={studioFixture()} workflow={hostileWorkflow} configuration={privateConfiguration} initialActivity={null} />
    );
    expect(screen.queryByRole('button', { name: 'Stage connected acquisition' })).not.toBeInTheDocument();
    expect(window.soterStudio.prepareAutomationRun).not.toHaveBeenCalled();
  });

  it('routes ready-for-acquisition work to a staged queue section without calling it review-ready', () => {
    const snapshot = studioFixture();
    const staged: Activity = {
      id: 'work.task-capture.connected-acquisition.ui-test',
      automationId: 'automation.task-capture',
      source: 'runtime',
      kind: 'prepared-work',
      label: 'Task Capture connected acquisition input',
      state: 'ready-for-acquisition',
      createdAt: '2026-07-16T15:30:00.000Z',
      updatedAt: '2026-07-16T15:30:00.000Z',
      host: 'codex',
      provider: null,
      capability: null,
      configurationLockFingerprint: 'sha256:' + '8'.repeat(64),
      graphFingerprint: 'sha256:' + '7'.repeat(64),
      recoveryId: null,
      preparedWorkRef: { workId: 'work.task-capture.connected-acquisition.ui-test' },
      timeline: [],
      evidence: []
    };
    snapshot.activity = [staged];
    render(<CatalogNav snapshot={snapshot} view="operate" selectedId={null} onSelect={vi.fn()} />);

    const section = screen.getByRole('heading', { name: /Staged for acquisition/ }).closest('section')!;
    expect(section).toHaveTextContent('staged input + lock');
    expect(section).toHaveTextContent('staged for acquisition');
    expect(screen.queryByRole('heading', { name: /Ready for review/ })).not.toBeInTheDocument();
  });

  it('offers only runnable Automations and does not classify impossible connected rollback states', () => {
    const snapshot = studioFixture();
    const guidanceOnly = structuredClone(snapshot.workflows[0]);
    guidanceOnly.id = 'automation.guidance-only';
    guidanceOnly.label = 'Guidance Only';
    guidanceOnly.operator!.preparation.supported = false;
    const impossibleRollback: Activity = {
      id: 'activity.impossible-rollback',
      automationId: snapshot.workflows[0].id,
      source: 'runtime',
      kind: 'connected-transaction',
      label: 'Impossible connected rollback state',
      state: 'rolled-back',
      createdAt: '2026-07-16T15:30:00.000Z',
      updatedAt: '2026-07-16T15:31:00.000Z',
      host: 'codex',
      provider: null,
      capability: null,
      configurationLockFingerprint: 'sha256:' + '8'.repeat(64),
      graphFingerprint: 'sha256:' + '7'.repeat(64),
      recoveryId: null,
      timeline: [],
      evidence: []
    };
    snapshot.workflows = [...snapshot.workflows, guidanceOnly];
    snapshot.activity = [impossibleRollback];

    render(<CatalogNav snapshot={snapshot} view="operate" selectedId={null} onSelect={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Guidance Only/ })).not.toBeInTheDocument();
    const other = screen.getByRole('heading', { name: /Other state/ }).closest('section')!;
    expect(other).toHaveTextContent('Impossible connected rollback state');
    expect(screen.queryByRole('heading', { name: /Recent/ })).not.toBeInTheDocument();
  });

  it('mechanically prepares Task Capture with private review and a held create proposal', async () => {
    const snapshot = studioFixture();
    const workflow = taskCaptureWorkflowFixture();
    const configuration = taskCaptureConfigurationFixture();
    const { container } = render(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Task title'), 'PRIVATE_TASK_UI_SENTINEL');
    await userEvent.type(screen.getByLabelText('Project reference'), 'soter-fixture://projects/project/launch');
    await userEvent.selectOptions(screen.getByLabelText('Assignee'), 'self');
    await userEvent.type(screen.getByLabelText('Next action date'), '2026-07-24');
    await userEvent.selectOptions(screen.getByLabelText('Task context'), 'Project');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'tracked-contained',
      preparationMode: 'contained',
      input: {
        title: 'PRIVATE_TASK_UI_SENTINEL',
        project: 'soter-fixture://projects/project/launch',
        assignee: 'self',
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
    expect(screen.getByRole('region', { name: 'Proposed change fingerprints' })).toHaveTextContent('tasks.records.create');
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
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={taskCaptureWorkflowFixture()} configuration={taskCaptureConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Task title'), 'Send launch deck');
    await userEvent.type(screen.getByLabelText('Project reference'), 'soter-fixture://projects/project/launch');
    await userEvent.selectOptions(screen.getByLabelText('Task context'), 'Project');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    expect(await screen.findByText('An exact-title task candidate exists and must be reviewed instead of silently creating a duplicate.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Proposed change fingerprints' })).not.toBeInTheDocument();
    expect(screen.getByText('0 proposed changes · write not proposed')).toBeVisible();
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(container.querySelector('.operator-confirmation-ceremony button')).not.toBeInTheDocument();
  });

  it('mechanically renders Email coverage, closed actions, exact private joins, and the no-authority stop', async () => {
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'SYNTHETIC_PRIVATE_MAILBOX_QUERY');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.type(screen.getByLabelText('Private focus notes'), 'SYNTHETIC_PRIVATE_FOCUS_NOTE');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.email-triage', configurationName: 'email-triage',
      configurationBasis: 'tracked-contained',
      preparationMode: 'contained',
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
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
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

    const dossier = await screen.findByRole('article', { name: 'Selected Email triage review-only proposal' });
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
    expect(screen.queryByRole('article', { name: 'Selected Email triage review-only proposal' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('Synthetic triage subject 1');
  });

  it('previews one exact label subset through Core before creating the separate approval request', async () => {
    const proposal = emailTriageAutomationProposalFixture();
    const labelAction = proposal.review.collections.flatMap((collection) => collection.rows)
      .flatMap((row) => row.actions).find((action) => action.state === 'proposed' && action.kind === 'label')!;
    const preview = emailTriageProposalConnectedPreviewFixture([labelAction.id]);
    window.soterStudio.previewProposalConnectedBatch = vi.fn().mockResolvedValue({ ok: true, preview });
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
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
    expect(screen.queryByRole('article', { name: 'Selected Email triage review-only proposal' })).not.toBeInTheDocument();
    expect(window.soterStudio.confirmConnectedApproval).not.toHaveBeenCalled();
    expect(window.soterStudio.startConnectedTransaction).not.toHaveBeenCalled();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('renders the stable stale-context code for an exact request and discards request transport prose', async () => {
    const proposal = emailTriageAutomationProposalFixture();
    const labelAction = proposal.review.collections.flatMap((collection) => collection.rows)
      .flatMap((row) => row.actions).find((action) => action.state === 'proposed' && action.kind === 'label')!;
    window.soterStudio.beginProposalConnectedApproval = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE',
        message: 'The exact connected proposal context is stale. Rebuild and review a current proposal before requesting, confirming, or starting.'
      }
    });
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), proposal.id);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    await userEvent.click((await screen.findAllByRole('checkbox', { name: /Select Label for exact connected scope/ }))[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Preview exact connected scope' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Request exact approval' }));
    expect(await screen.findByText('PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE')).toBeVisible();
    expect(screen.getByText(/Rebuild and review a current proposal/)).toBeVisible();
    expect(screen.queryByText('Awaiting exact approval')).not.toBeInTheDocument();
    first.unmount();

    window.soterStudio.beginProposalConnectedApproval = vi.fn().mockRejectedValueOnce(
      new Error('PRIVATE_REQUEST_PATH_SENTINEL /Users/operator/.soter/state/approval.json')
    );
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), proposal.id);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    await userEvent.click((await screen.findAllByRole('checkbox', { name: /Select Label for exact connected scope/ }))[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Preview exact connected scope' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Request exact approval' }));
    expect(await screen.findByText('PROPOSAL_CONNECTED_APPROVAL_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The exact connected approval request is unavailable.')).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_REQUEST_PATH_SENTINEL');
    expect(second.container).not.toHaveTextContent('/Users/operator/.soter/state/approval.json');
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
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Select Draft for exact connected scope/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview exact connected scope' }));
    expect(await screen.findByText('PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The selected proposal actions do not have one exact connected write and verification provider.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request exact approval' })).not.toBeInTheDocument();
    first.unmount();

    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
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
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
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
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Exact proposal ID'), 'proposal.email-triage.ui-test');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect selected proposal' }));
    expect(await screen.findByText(/does not bind this exact proposal, decision, Automation, configuration, review contract, and content seal/i)).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_PROPOSAL_BINDING_SENTINEL');
    expect(within(screen.getByRole('region', { name: 'Selected proposal private material' })).queryByRole('button')).not.toBeInTheDocument();
  });

  it('creates an exact review-only Email subset and replaces request order with Core canonical order', async () => {
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
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
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only candidate selection (2)' }));

    expect(window.soterStudio.createReviewOnlyCandidateSelection).toHaveBeenCalledWith({
      workId: 'work.email-triage.ui-test',
      actionIds: ['action.email.001.draft', 'action.email.001.label']
    });
    await waitFor(() => expect(window.soterStudio.getReviewOnlyCandidateSelectionMaterial).toHaveBeenCalledWith({
      selectionId: emailTriageCandidateSelectionFixture().id
    }));
    const folio = await screen.findByRole('region', { name: 'Review-only candidate selection private folio' });
    const ordered = folio.querySelectorAll('.candidate-selection-actions > li');
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toHaveTextContent('01');
    expect(ordered[0]).toHaveTextContent('Label');
    expect(ordered[1]).toHaveTextContent('02');
    expect(ordered[1]).toHaveTextContent('Draft');
    expect(folio).toHaveTextContent('Synthetic complete draft body for local review. No message has been sent.');
    expect(folio).toHaveTextContent('Exact message IDs');
    expect(folio).toHaveTextContent('Exact label name');
    expect(folio).toHaveTextContent('Exact reply message ID');
    expect(folio).toHaveTextContent('REVIEW_ONLY_CANDIDATE_PREVIEW_NOT_CREATED');
    expect(folio).toHaveTextContent('CONNECTED_VERIFICATION_NOT_PROVEN');
    expect(folio).toHaveTextContent('Review-only selection cannot approve, confirm, continue, retry, execute, write, or send.');
    expect(within(folio).queryByRole('button', { name: /approve|confirm|continue|retry|execute|write|send/i })).not.toBeInTheDocument();

    await userEvent.click(within(folio).getByRole('button', { name: 'Create review-only candidate preview' }));
    expect(window.soterStudio.createReviewOnlyCandidatePreview).toHaveBeenCalledWith({ selectionId: emailTriageCandidateSelectionFixture().id });
    await waitFor(() => expect(window.soterStudio.getReviewOnlyCandidatePreview).toHaveBeenCalledWith({ candidatePreviewId: emailTriageCandidatePreviewFixture().id }));
    const candidate = await screen.findByRole('region', { name: 'Selected review-only candidate preview private ledger' });
    expect(candidate.querySelectorAll('.candidate-preview-operations > li')).toHaveLength(2);
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

    await userEvent.click(within(folio).getByRole('button', { name: 'End candidate review' }));
    expect(screen.queryByRole('region', { name: 'Review-only candidate selection private folio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected review-only candidate preview private ledger' })).not.toBeInTheDocument();
    expect(screen.getByText('0 of 11 proposed actions selected')).toBeVisible();
  });

  it('withholds candidate-preview values on hostile transport or exact-binding failure', async () => {
    vi.mocked(window.soterStudio.getReviewOnlyCandidatePreview).mockRejectedValueOnce(
      new Error('PRIVATE_CANDIDATE_PREVIEW_TRANSPORT_SENTINEL /Users/operator/.soter/state/review-only-candidate-previews')
    );
    const first = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only candidate selection (2)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create review-only candidate preview' }));
    expect(await screen.findByText('REVIEW_ONLY_CANDIDATE_PREVIEW_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private review-only candidate preview material is unavailable.')).toBeVisible();
    expect(first.container).not.toHaveTextContent('PRIVATE_CANDIDATE_PREVIEW_TRANSPORT_SENTINEL');
    expect(first.container).not.toHaveTextContent('/Users/operator/.soter/state/review-only-candidate-previews');
    first.unmount();

    const mismatched = emailTriageCandidatePreviewFixture();
    mismatched.source.selectionId = 'review-only-candidate-selection.email-triage.binding-mismatch';
    mismatched.operations[0].input.messageIds = ['PRIVATE_CANDIDATE_PREVIEW_BINDING_SENTINEL'];
    window.soterStudio.getReviewOnlyCandidatePreview = vi.fn().mockResolvedValue({ ok: true, preview: mismatched });
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only candidate selection (2)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create review-only candidate preview' }));
    expect(await screen.findByText(/does not bind this exact review-only selection, work, lock, and source action set/i)).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_CANDIDATE_PREVIEW_BINDING_SENTINEL');
    expect(screen.queryByRole('region', { name: 'Selected review-only candidate preview private ledger' })).not.toBeInTheDocument();
  });

  it('withholds candidate-selection values and hostile transport prose on adapter or binding failure', async () => {
    vi.mocked(window.soterStudio.getReviewOnlyCandidateSelectionMaterial).mockRejectedValueOnce(
      new Error('PRIVATE_SELECTION_TRANSPORT_SENTINEL /Users/operator/.soter/state/review-only-candidate-selections')
    );
    const { container, unmount } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only candidate selection (2)' }));
    expect(await screen.findByText('REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private review-only candidate selection material is unavailable.')).toBeVisible();
    expect(container).not.toHaveTextContent('PRIVATE_SELECTION_TRANSPORT_SENTINEL');
    expect(container).not.toHaveTextContent('/Users/operator/.soter/state/review-only-candidate-selections');
    unmount();

    const mismatched = emailTriageCandidateSelectionMaterialFixture();
    mismatched.selection.id = 'review-only-candidate-selection.email-triage.binding-mismatch';
    mismatched.actions[0].proposed.fields[0].reviewValue = 'PRIVATE_SELECTION_BINDING_SENTINEL';
    window.soterStudio.getReviewOnlyCandidateSelectionMaterial = vi.fn().mockResolvedValue({ ok: true, material: mismatched });
    const second = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
    await userEvent.type(screen.getByLabelText('Mailbox window query'), 'synthetic bounded query');
    await userEvent.selectOptions(screen.getByLabelText('Processing scope'), 'triage-drafts-handoffs-digest');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Draft for review' }));
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Select Label for review' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Create review-only candidate selection (2)' }));
    expect(await screen.findByText(/does not bind the exact selection, work, source rows, and selected fingerprints/i)).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_SELECTION_BINDING_SENTINEL');
  });

  it('withholds derived Email values and hostile transport prose when the selected private read fails', async () => {
    vi.mocked(window.soterStudio.getPreparedWorkDerivedReview).mockRejectedValueOnce(
      new Error('HOSTILE_DERIVED_BODY_SENTINEL /private/mail/body.txt')
    );
    const { container } = render(<OperatorView snapshot={studioFixture()} workflow={emailTriageWorkflowFixture()} configuration={emailTriageConfigurationFixture()} initialActivity={null} />);
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

  it('mechanically prepares Project Pulse and renders the exact private write-review boundary', async () => {
    const { container } = render(<App />);
    expect(await screen.findByText('Operator workspace · canonical projection')).toBeVisible();
    expect(screen.getByText('Example only · no authority')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Project reference'), 'https://www.notion.so/11111111111111111111111111111111');
    await userEvent.type(screen.getByLabelText('Status date'), '2026-07-20');
    await userEvent.selectOptions(screen.getByLabelText('Visibility'), 'Internal');
    await userEvent.selectOptions(screen.getByLabelText('Project health judgment'), 'on-track');
    expect(screen.getByLabelText('Health milestone titles')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Operator note'), 'PRIVATE_UI_NOTE_SENTINEL');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.project-pulse',
      configurationName: 'project-pulse',
      configurationBasis: 'tracked-contained',
      preparationMode: 'contained',
      input: {
        project: 'https://www.notion.so/11111111111111111111111111111111',
        statusDate: '2026-07-20',
        visibility: 'Internal',
        health: 'on-track',
        operatorGoal: 'PRIVATE_UI_NOTE_SENTINEL'
      }
    }));
    expect(await screen.findByText('Private preparation receipt')).toBeVisible();
    expect(screen.getByText('PREPARATION_READY_FOR_REVIEW')).toBeVisible();
    expect(screen.getByText('Project Pulse preview')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('read');
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('disclosure');
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('write');
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('not executed');
    expect(screen.getByRole('region', { name: 'Preparation effect boundary' })).toHaveTextContent('completed contained');
    expect(screen.getByText('Proposed change ledger')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Prepared review collections' })).toHaveTextContent('documents.content.update');
    expect(screen.getByRole('region', { name: 'Prepared review collections' })).toHaveTextContent('projects.records.create');
    expect(await screen.findByRole('region', { name: 'Selected private derived review' })).toHaveTextContent('Launch readiness');
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(screen.getAllByText('Private value · submitted only to local Core preparation · never returned in inspection').length).toBeGreaterThan(0);
    expect(screen.getByText(/Private inputs originate in this renderer and are sent only to the trusted local Core preparation operation/)).toBeVisible();
    expect(screen.getAllByText('fingerprinted · raw absent').length).toBeGreaterThanOrEqual(2);
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
    await userEvent.type(screen.getByLabelText('Project reference'), 'https://www.notion.so/11111111111111111111111111111111');
    await userEvent.type(screen.getByLabelText('Status date'), '2026-07-20');
    await userEvent.selectOptions(screen.getByLabelText('Visibility'), 'Internal');
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
    await userEvent.type(screen.getByLabelText('Project reference'), 'https://www.notion.so/11111111111111111111111111111111');
    await userEvent.type(screen.getByLabelText('Status date'), '2026-07-20');
    await userEvent.selectOptions(screen.getByLabelText('Visibility'), 'Internal');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    expect(await screen.findByText('PREPARED_REVIEW_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('Private review material is unavailable for this prepared work.')).toBeVisible();
    expect(container).not.toHaveTextContent('HOSTILE_PRIVATE_PATH_SENTINEL');
    expect(container).not.toHaveTextContent('/private/user/secrets.json');
  });

  it('mechanically prepares Meeting Intake without inventing judgment or write authority', async () => {
    window.location.hash = '#/operate/automation.meeting-intake';
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Automation Meeting Intake' })).toBeVisible();
    await userEvent.type(screen.getByLabelText('Transcript meeting reference'), 'meeting.fixture-001');
    await userEvent.type(screen.getByLabelText('Recording reference'), 'https://otter.ai/u/meeting_fixture_001');
    await userEvent.type(screen.getByLabelText('Desired outcome'), 'PRIVATE_MEETING_UI_GOAL');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare contained run' }));
    await waitFor(() => expect(window.soterStudio.prepareAutomationRun).toHaveBeenCalledWith({
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      configurationBasis: 'tracked-contained',
      preparationMode: 'contained',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: 'https://otter.ai/u/meeting_fixture_001',
        operatorGoal: 'PRIVATE_MEETING_UI_GOAL'
      }
    }));
    expect(await screen.findByText('Meeting Intake preview')).toBeVisible();
    expect(screen.getByText('Relationships and follow-up candidates require cited judgment')).toBeVisible();
    expect(screen.getByText('Participant identity resolution')).toBeVisible();
    expect(screen.getByText('0 proposed changes · judgment not performed')).toBeVisible();
    expect(screen.getByText('No approval request')).toBeVisible();
    expect(screen.getAllByText(/COMPLETE_MEETING_READBACK_UNAVAILABLE/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Proposed change ledger')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve exact request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Consume approval + start' })).not.toBeInTheDocument();
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('https://otter.ai/u/meeting_fixture_001');
    expect(container.querySelector('.dossier-inputs')).not.toHaveTextContent('PRIVATE_MEETING_UI_GOAL');
    expect(container.querySelector('.dossier-private-review')).toHaveTextContent('https://otter.ai/u/meeting_fixture_001');
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

  it('renders stale confirmation as a typed no-authority result and never parses rejection prose', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.confirmConnectedApproval = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE',
        message: 'The exact connected proposal context is stale. Rebuild and review a current proposal before requesting, confirming, or starting.'
      }
    });
    window.location.hash = `#/operate/${activity.id}`;
    const first = render(<App />);
    await userEvent.click(await screen.findByLabelText(/I reviewed the exact lock/i));
    await userEvent.click(screen.getByRole('button', { name: 'Approve exact request' }));
    expect(await screen.findByText('PROPOSAL_CONNECTED_BATCH_CONTEXT_STALE')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve exact request' })).toBeVisible();
    expect(window.soterStudio.startConnectedTransaction).not.toHaveBeenCalled();
    first.unmount();

    window.soterStudio.confirmConnectedApproval = vi.fn().mockRejectedValueOnce(
      new Error('PRIVATE_CONFIRM_PATH_SENTINEL /Users/operator/.soter/state/approval.json')
    );
    const second = render(<App />);
    await userEvent.click(await screen.findByLabelText(/I reviewed the exact lock/i));
    await userEvent.click(screen.getByRole('button', { name: 'Approve exact request' }));
    expect(await screen.findByText('CONNECTED_APPROVAL_CONFIRM_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The exact connected approval could not be confirmed.')).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_CONFIRM_PATH_SENTINEL');
    expect(second.container).not.toHaveTextContent('/Users/operator/.soter/state/approval.json');
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
    const { container, rerender } = render(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={activity} />);
    expect(await screen.findByText('Source context is unavailable; no value is represented.')).toBeVisible();
    expect(screen.getAllByText('SOURCE_CONTEXT_UNAVAILABLE').length).toBeGreaterThan(0);
    expect(container).toHaveTextContent('PRIVATE_APPROVAL_PROPOSED_SENTINEL');
    rerender(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={null} />);
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
    const { container } = render(<OperatorView snapshot={snapshot} workflow={workflow} configuration={configuration} initialActivity={activity} />);
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

  it('renders exact start preflight failure without consuming approval or exposing transport prose', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    activity.operatorRef = { requestId: 'approval-request.project-pulse.ui-test', approvalId: 'approval.project-pulse.ui-test', checkpointId: null };
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(operatorInspectionFixture('approved-not-started'));
    window.soterStudio.startConnectedTransaction = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CONNECTED_TRANSACTION_PREFLIGHT_FAILED',
        reasonCode: 'HOST_CALL_VALIDATION_FAILED',
        message: 'The exact connected transaction could not prepare its provider call. No approval was consumed and no checkpoint or provider effect was created.'
      }
    });
    window.location.hash = `#/operate/${activity.id}`;
    const first = render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Consume approval + start' }));
    expect(await screen.findByText('CONNECTED_TRANSACTION_PREFLIGHT_FAILED')).toBeVisible();
    expect(screen.getByText('HOST_CALL_VALIDATION_FAILED')).toBeVisible();
    expect(screen.getByText(/No approval was consumed and no checkpoint or provider effect was created/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Consume approval + start' })).toBeVisible();
    first.unmount();

    window.soterStudio.startConnectedTransaction = vi.fn().mockRejectedValueOnce(
      new Error('PRIVATE_PREFLIGHT_PATH_SENTINEL /Users/operator/.soter/state/provider-call.json')
    );
    const second = render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Consume approval + start' }));
    expect(await screen.findByText('CONNECTED_TRANSACTION_START_ADAPTER_UNAVAILABLE')).toBeVisible();
    expect(screen.getByText('The exact connected transaction could not be started.')).toBeVisible();
    expect(second.container).not.toHaveTextContent('PRIVATE_PREFLIGHT_PATH_SENTINEL');
    expect(second.container).not.toHaveTextContent('/Users/operator/.soter/state/provider-call.json');
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
    expect(screen.getByText('projects.records.read')).toBeVisible();
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

  it('keeps a non-private configuration basis unavailable without inventing continuation authority', async () => {
    const snapshot = studioFixture();
    const activity = connectedActivityFixture();
    activity.state = 'blocked';
    activity.operatorRef = { requestId: 'approval-request.project-pulse.ui-test', approvalId: 'approval.project-pulse.ui-test', checkpointId: 'checkpoint.transaction.project-pulse.ui-test' };
    snapshot.activity.unshift(activity);
    window.soterStudio.getWorkspaceSnapshot = vi.fn().mockResolvedValue(snapshot);
    window.soterStudio.getOperatorActivity = vi.fn().mockResolvedValue(operatorRecoveryInspectionFixture('basis-unavailable'));
    window.location.hash = `#/operate/${activity.id}`;
    render(<App />);
    expect((await screen.findAllByText('CONFIGURATION_BASIS_NOT_PRIVATE_ACTIVE')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'No executable continuation' })).toBeDisabled();
    expect(window.soterStudio.prepareConnectedReconciliation).not.toHaveBeenCalled();
  });

  it('mechanically renders the full input control matrix with WCAG semantics', async () => {
    const fields: OperatorInputField[] = [
      { id: 'project', label: 'Project reference', description: 'Exact project identifier.', type: 'reference', required: true, exposure: 'identifier', reference: { subject: 'projects.records.project', authorityRole: 'instance' }, examples: ['project.fixture-001'] },
      { id: 'thread', label: 'Email thread', description: 'Private provider reference.', type: 'uri', required: true, exposure: 'private' },
      { id: 'scope', label: 'Task scope', description: 'Declared task boundary.', type: 'enum', required: true, exposure: 'identifier', options: ['open', 'all'] },
      { id: 'approved', label: 'Scope acknowledged', description: 'Required acknowledgement.', type: 'boolean', required: true, exposure: 'identifier' },
      { id: 'due', label: 'Due date', description: 'Requested completion date.', type: 'date', required: false, exposure: 'identifier' },
      { id: 'notes', label: 'Optional notes', description: 'Private operator intent.', type: 'string', required: false, exposure: 'private', constraints: { minLength: 3, maxLength: 120 } },
      { id: 'tags', label: 'Organization tags', description: 'Private exact tag values.', type: 'string-list', required: false, exposure: 'private', constraints: { minItems: 0, maxItems: 8, itemMinLength: 2, itemMaxLength: 80 }, examples: [['Prospect', 'Priority']] }
    ];
    const { container } = render(<form>{fields.map((field) => <OperatorInputControl key={field.id} field={field} value={field.type === 'boolean' ? false : field.type === 'string-list' ? [] : ''} onChange={vi.fn()} />)}</form>);
    expect(screen.getByLabelText('Project reference')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Email thread')).toHaveAttribute('inputmode', 'url');
    expect(screen.getByLabelText('Task scope')).toBeRequired();
    expect(screen.getByLabelText('Scope acknowledged')).toHaveAttribute('type', 'checkbox');
    expect(screen.getByLabelText('Due date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Optional notes').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Organization tags').tagName).toBe('TEXTAREA');
    expect(screen.getByRole('button', { name: 'Use Prospect, Priority for Organization tags' })).toBeVisible();
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
      capability: 'projects.records.create',
      authority: 'authority.projects.instance',
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
