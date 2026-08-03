import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import lifecycleFixture from '../../../../fixtures/operator-inspection/connected-transaction.lifecycle.json';
import type { Activity, AutomationProposal, AutomationProposalMaterial, AutomationProposalMaterialResult, AutomationProposalResult, Configuration, ConnectedApprovalReviewMaterial, ConnectedApprovalReviewResult, ConnectedOperatorActionResult, InspectionSnapshot, OperatorInspection, OperatorPreparationMode, PreparationMode, PreparedWork, PreparedWorkDerivedReviewMaterial, PreparedWorkDerivedReviewResult, PreparedWorkReviewError, PreparedWorkReviewMaterial, PreparedWorkReviewResult, ProposalConnectedApprovalResult, ProposalConnectedBatchPreview, ProposalConnectedBatchResult, Workflow } from '../types';
import { AutomationProposalDossier, automationProposalMaterialBound } from './AutomationProposalDossier';
import { ConnectedApprovalReview } from './ConnectedApprovalReview';
import { OperatorInputControl } from './OperatorInputControl';
import { PreparedWorkDossier } from './PreparedWorkDossier';
import { StateMark } from './StateMark';

type ExampleState = (typeof lifecycleFixture.states)[number];
type AutomationProposalRoute = {
  automationId: string;
  configurationName: string;
  label: string;
  placeholder: string;
};

const automationProposalRoutes = new Map<string, AutomationProposalRoute>([
  ['automation.email-triage', {
    automationId: 'automation.email-triage',
    configurationName: 'email-triage',
    label: 'Email triage',
    placeholder: 'proposal.email-triage…'
  }],
  ['automation.project-capture', {
    automationId: 'automation.project-capture',
    configurationName: 'project-capture',
    label: 'Project Capture',
    placeholder: 'proposal.project-capture…'
  }],
  ['automation.project-page-reconciliation', {
    automationId: 'automation.project-page-reconciliation',
    configurationName: 'project-page-reconciliation',
    label: 'Project Page Reconciliation',
    placeholder: 'proposal.project-page-reconciliation…'
  }]
]);

export function OperatorView({
  snapshot,
  workflow,
  configuration,
  initialActivity
}: {
  snapshot: InspectionSnapshot;
  workflow: Workflow;
  configuration: Configuration | null;
  initialActivity: Activity | null;
}) {
  const [selectedScenarioId, setSelectedScenarioId] = useState(workflow.scenarios[0]?.id || '');
  const [selectedExampleId, setSelectedExampleId] = useState('awaiting-approval');
  const [input, setInput] = useState<Record<string, string | boolean | string[]>>({});
  const [inspection, setInspection] = useState<OperatorInspection | null>(null);
  const [preparedWork, setPreparedWork] = useState<PreparedWork | null>(null);
  const [reviewMaterial, setReviewMaterial] = useState<PreparedWorkReviewMaterial | null>(null);
  const [reviewError, setReviewError] = useState<PreparedWorkReviewError | null>(null);
  const [derivedReviewMaterial, setDerivedReviewMaterial] = useState<PreparedWorkDerivedReviewMaterial | null>(null);
  const [derivedReviewError, setDerivedReviewError] = useState<PreparedWorkReviewError | null>(null);
  const [approvalReviewMaterial, setApprovalReviewMaterial] = useState<ConnectedApprovalReviewMaterial | null>(null);
  const [approvalReviewError, setApprovalReviewError] = useState<PreparedWorkReviewError | null>(null);
  const [proposalId, setProposalId] = useState('');
  const [automationProposal, setAutomationProposal] = useState<AutomationProposal | null>(null);
  const [automationProposalMaterial, setAutomationProposalMaterial] = useState<AutomationProposalMaterial | null>(null);
  const [automationProposalError, setAutomationProposalError] = useState<PreparedWorkReviewError | null>(null);
  const [automationProposalMaterialError, setAutomationProposalMaterialError] = useState<PreparedWorkReviewError | null>(null);
  const [proposalSelection, setProposalSelection] = useState<string[]>([]);
  const [connectedPreview, setConnectedPreview] = useState<ProposalConnectedBatchPreview | null>(null);
  const [connectedPreviewError, setConnectedPreviewError] = useState<PreparedWorkReviewError | null>(null);
  const [connectedPreviewBusy, setConnectedPreviewBusy] = useState(false);
  const [proposalApprovalBusy, setProposalApprovalBusy] = useState(false);
  const [connectedActionError, setConnectedActionError] = useState<PreparedWorkReviewError | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [preparationBusy, setPreparationBusy] = useState<PreparationMode | null>(null);
  const [scopeConfirmed, setScopeConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposalEpoch = useRef(0);
  const scenario = workflow.scenarios.find((item) => item.id === selectedScenarioId) || workflow.scenarios[0];
  const example = lifecycleFixture.states.find((item) => item.id === selectedExampleId) || lifecycleFixture.states[0];
  const clearProposalConnectedState = useCallback(() => {
    setProposalSelection([]);
    setConnectedPreview(null);
    setConnectedPreviewError(null);
    setConnectedPreviewBusy(false);
    setProposalApprovalBusy(false);
    setConnectedActionError(null);
  }, []);

  useEffect(() => {
    proposalEpoch.current += 1;
    setInput({});
    setInspection(null);
    setPreparedWork(null);
    setReviewMaterial(null);
    setReviewError(null);
    setDerivedReviewMaterial(null);
    setDerivedReviewError(null);
    setApprovalReviewMaterial(null);
    setApprovalReviewError(null);
    setProposalId('');
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    setProposalBusy(false);
    clearProposalConnectedState();
    setError(null);
    setScopeConfirmed(false);
    setSelectedScenarioId(workflow.scenarios[0]?.id || '');
  }, [workflow.id, configuration?.lockFingerprint, clearProposalConnectedState]);

  useEffect(() => {
    if (initialActivity?.operatorRef || initialActivity?.preparedWorkRef) return;
    proposalEpoch.current += 1;
    setInspection(null);
    setPreparedWork(null);
    setReviewMaterial(null);
    setReviewError(null);
    setDerivedReviewMaterial(null);
    setDerivedReviewError(null);
    setApprovalReviewMaterial(null);
    setApprovalReviewError(null);
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    setProposalBusy(false);
    clearProposalConnectedState();
    setScopeConfirmed(false);
  }, [initialActivity?.id, clearProposalConnectedState]);

  useEffect(() => {
    if (!initialActivity?.operatorRef && !initialActivity?.preparedWorkRef) return;
    let current = true;
    proposalEpoch.current += 1;
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    setProposalBusy(false);
    clearProposalConnectedState();
    setLoading(true);
    setError(null);
    const request = initialActivity.preparedWorkRef
      ? window.soterStudio.getPreparedWork({ workId: initialActivity.preparedWorkRef.workId })
      : window.soterStudio.getOperatorActivity({
          requestId: initialActivity.operatorRef!.requestId,
          ...(initialActivity.operatorRef!.approvalId ? { approvalId: initialActivity.operatorRef!.approvalId } : {}),
          ...(initialActivity.operatorRef!.checkpointId ? { checkpointId: initialActivity.operatorRef!.checkpointId } : {})
        });
    request
      .then((value) => {
        if (!current) return;
        if (value.$contract === 'soter://contracts/prepared-work/v1') {
          setPreparedWork(value);
          setInspection(null);
          setReviewMaterial(null);
          setReviewError(null);
          setDerivedReviewMaterial(null);
          setDerivedReviewError(null);
          setApprovalReviewMaterial(null);
          setApprovalReviewError(null);
          loadPreparedPrivateSurfaces(value)
            .then(({ review, derived }) => {
              if (!current) return;
              setReviewMaterial(review.ok ? review.material : null);
              setReviewError(review.ok ? null : review.error);
              setDerivedReviewMaterial(derived?.ok ? derived.material : null);
              setDerivedReviewError(derived && !derived.ok ? derived.error : null);
            });
        } else {
          setInspection(value);
          setPreparedWork(null);
          setReviewMaterial(null);
          setReviewError(null);
          setDerivedReviewMaterial(null);
          setDerivedReviewError(null);
          setApprovalReviewMaterial(null);
          setApprovalReviewError(null);
          loadConnectedApprovalReview(value).then((result) => {
            if (!current) return;
            setApprovalReviewMaterial(result.ok ? result.material : null);
            setApprovalReviewError(result.ok ? null : result.error);
          });
        }
      })
      .catch((reason) => { if (current) setError(message(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [initialActivity?.id, snapshot, clearProposalConnectedState]);

  const view = inspection ? inspectionView(inspection) : exampleView(example);
  const currentState = automationProposal?.state || preparedWork?.state || view.workState;
  const stagedAcquisition = preparedWork?.preparationMode === 'connected-acquisition';
  const confirmingEffects = configuration?.effectPolicies.filter((policy) => policy.mode === 'confirm') || [];
  const preparedHeldReasonCodes = preparedWork ? [...new Set(preparedWork.preview.collections.flatMap((collection) => (
    collection.rows.flatMap((row) => row.actions
      .filter((action) => action.state === 'held')
      .map((action) => action.reasonCode))
  )))].sort() : [];
  const fixtureRuns = useMemo(() => workflow.scenarios.filter((item) => item.execution), [workflow.scenarios]);
  const preparationModes = workflow.operator?.preparation.modes || [];
  const containedMode = preparationModes.find(isContainedPreparationMode);
  const connectedMode = preparationModes.find(isConnectedAcquisitionMode);
  const exactConfigurationBinding = Boolean(
    workflow.configuration
    && configuration
    && workflow.configuration === configuration.name
    && workflow.configurationBasis === configuration.configurationBasis
  );
  const proposalRoute = exactConfigurationBinding
    ? automationProposalRoutes.get(workflow.id) || null
    : null;
  const exactProposalRoute = proposalRoute
    && proposalRoute.configurationName === configuration?.name
    && proposalRoute.automationId === workflow.id
    ? proposalRoute
    : null;
  const canPrepareContained = Boolean(
    workflow.operator?.preparation.supported
    &&
    containedMode
    && exactConfigurationBinding
    && workflow.configurationBasis
    && containedMode.configurationBases.includes(workflow.configurationBasis)
  );
  const canStageConnectedAcquisition = Boolean(
    workflow.operator?.preparation.supported
    &&
    connectedMode
    && exactConfigurationBinding
    && workflow.configurationBasis === 'private-active'
    && configuration?.configurationBasis === 'private-active'
    && connectedMode.configurationBases.includes('private-active')
    && connectedMode.availability.state === 'available'
  );
  const proposalMaterialReady = Boolean(automationProposal && automationProposalMaterial && configuration?.lockFingerprint
    && automationProposalMaterialBound(automationProposal, automationProposalMaterial, configuration.name, configuration.lockFingerprint));

  async function confirmApproval() {
    if (!inspection || inspection.approval.state !== 'awaiting' || !scopeConfirmed) return;
    setActionBusy(true);
    setError(null);
    setConnectedActionError(null);
    const approvalId = inspection.approval.request.id.replace(/^approval-request\./, 'approval.');
    const result = await window.soterStudio.confirmConnectedApproval({
      requestId: inspection.approval.request.id,
      approvalId,
      confirmed: true,
      reason: 'Approved in Soter Studio after exact-scope review'
    }).catch((): ConnectedOperatorActionResult => ({
      ok: false,
      error: {
        code: 'CONNECTED_APPROVAL_CONFIRM_ADAPTER_UNAVAILABLE',
        message: 'The exact connected approval could not be confirmed.'
      }
    }));
    if (result.ok) {
      setInspection(result.inspection);
      setApprovalReviewMaterial(null);
      setApprovalReviewError(null);
      setScopeConfirmed(false);
    } else {
      setConnectedActionError(result.error);
    }
    setActionBusy(false);
  }

  async function startTransaction() {
    const approvalId = inspection?.approval.confirmation?.id;
    if (!approvalId) return;
    setActionBusy(true);
    setError(null);
    setConnectedActionError(null);
    const result = await window.soterStudio.startConnectedTransaction({ approvalId })
      .catch((): ConnectedOperatorActionResult => ({
        ok: false,
        error: {
          code: 'CONNECTED_TRANSACTION_START_ADAPTER_UNAVAILABLE',
          message: 'The exact connected transaction could not be started.'
        }
      }));
    if (result.ok) {
      setInspection(result.inspection);
      setApprovalReviewMaterial(null);
      setApprovalReviewError(null);
    } else {
      setConnectedActionError(result.error);
    }
    setActionBusy(false);
  }

  async function prepareReconciliation() {
    const continuation = inspection?.continuationRequest;
    if (!continuation || continuation.kind !== 'prepare-reconciliation') return;
    setActionBusy(true);
    setError(null);
    try {
      const next = await window.soterStudio.prepareConnectedReconciliation({
        checkpointId: continuation.checkpointId
      });
      setInspection(next);
      setApprovalReviewMaterial(null);
      setApprovalReviewError(null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setActionBusy(false);
    }
  }

  async function prepareRun(preparationMode: PreparationMode) {
    if (!workflow.operator?.preparation.supported
      || !workflow.configuration
      || !workflow.configurationBasis
      || actionBusy) return;
    const mode = preparationMode === 'contained'
      ? workflow.operator.preparation.modes.find(isContainedPreparationMode)
      : workflow.operator.preparation.modes.find(isConnectedAcquisitionMode);
    if (!mode
      || !exactConfigurationBinding
      || (mode.id === 'contained'
        ? !mode.configurationBases.includes(workflow.configurationBasis)
        : workflow.configurationBasis !== 'private-active'
          || !mode.configurationBases.includes('private-active')
          || mode.availability.state !== 'available')
      || (preparationMode === 'connected-acquisition'
        && workflow.configurationBasis !== 'private-active')) return;
    proposalEpoch.current += 1;
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    clearProposalConnectedState();
    setActionBusy(true);
    setPreparationBusy(preparationMode);
    setError(null);
    setReviewMaterial(null);
    setReviewError(null);
    setDerivedReviewMaterial(null);
    setDerivedReviewError(null);
    setApprovalReviewMaterial(null);
    setApprovalReviewError(null);
    try {
      const next = await window.soterStudio.prepareAutomationRun({
        automationId: workflow.id,
        configurationName: workflow.configuration,
        configurationBasis: workflow.configurationBasis,
        preparationMode,
        input
      });
      setPreparedWork(next);
      setInspection(null);
      const { review, derived } = await loadPreparedPrivateSurfaces(next);
      setReviewMaterial(review.ok ? review.material : null);
      setReviewError(review.ok ? null : review.error);
      setDerivedReviewMaterial(derived?.ok ? derived.material : null);
      setDerivedReviewError(derived && !derived.ok ? derived.error : null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setActionBusy(false);
      setPreparationBusy(null);
    }
  }

  async function inspectAutomationProposal() {
    if (!exactProposalRoute || !configuration?.lockFingerprint
      || !proposalId.trim() || proposalBusy) return;
    const epoch = proposalEpoch.current + 1;
    proposalEpoch.current = epoch;
    const request = {
      proposalId: proposalId.trim(),
      configurationName: configuration.name,
      lockFingerprint: configuration.lockFingerprint
    };
    setProposalBusy(true);
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    clearProposalConnectedState();
    const inspected = await window.soterStudio.getAutomationProposal(request)
      .catch((): AutomationProposalResult => ({
        ok: false,
        error: {
          code: 'AUTOMATION_PROPOSAL_TRANSPORT_UNAVAILABLE',
          message: 'The selected review-only proposal is unavailable.'
        }
      }));
    if (proposalEpoch.current !== epoch) return;
    if (!inspected.ok) {
      setAutomationProposalError(inspected.error);
      setProposalBusy(false);
      return;
    }
    if (inspected.proposal.automation.id !== exactProposalRoute.automationId) {
      setAutomationProposalError({
        code: 'AUTOMATION_PROPOSAL_BINDING_INVALID',
        message: 'The selected review-only proposal is unavailable.'
      });
      setProposalBusy(false);
      return;
    }
    setAutomationProposal(inspected.proposal);
    setInspection(null);
    setPreparedWork(null);
    setReviewMaterial(null);
    setDerivedReviewMaterial(null);
    setApprovalReviewMaterial(null);
    const privateMaterial = await window.soterStudio.getAutomationProposalMaterial(request)
      .catch((): AutomationProposalMaterialResult => ({
        ok: false,
        error: {
          code: 'AUTOMATION_PROPOSAL_MATERIAL_TRANSPORT_UNAVAILABLE',
          message: 'Private proposal material is unavailable for this selected proposal.'
        }
      }));
    if (proposalEpoch.current !== epoch) return;
    setAutomationProposalMaterial(privateMaterial.ok ? privateMaterial.material : null);
    setAutomationProposalMaterialError(privateMaterial.ok ? null : privateMaterial.error);
    setProposalBusy(false);
  }

  function toggleProposalAction(actionId: string) {
    setProposalSelection((current) => current.includes(actionId)
      ? current.filter((id) => id !== actionId)
      : [...current, actionId]);
    setConnectedPreview(null);
    setConnectedPreviewError(null);
  }

  async function previewProposalConnectedSubset() {
    if (!automationProposal || !configuration?.lockFingerprint || !proposalMaterialReady
      || proposalSelection.length === 0 || connectedPreviewBusy || proposalApprovalBusy) return;
    setConnectedPreviewBusy(true);
    setConnectedPreview(null);
    setConnectedPreviewError(null);
    const epoch = proposalEpoch.current;
    const result = await window.soterStudio.previewProposalConnectedBatch({
      proposalId: automationProposal.id,
      configurationName: configuration.name,
      lockFingerprint: configuration.lockFingerprint,
      actionIds: proposalSelection
    }).catch((): ProposalConnectedBatchResult => ({
      ok: false,
      error: {
        code: 'PROPOSAL_CONNECTED_BATCH_ADAPTER_UNAVAILABLE',
        message: 'The exact connected proposal preview is unavailable.'
      }
    }));
    if (proposalEpoch.current !== epoch) return;
    if (result.ok) {
      setProposalSelection(result.preview.selection.actionIds);
      setConnectedPreview(result.preview);
    } else {
      setConnectedPreviewError(result.error);
    }
    setConnectedPreviewBusy(false);
  }

  async function beginProposalApproval() {
    if (!automationProposal || !configuration?.lockFingerprint || !connectedPreview
      || proposalApprovalBusy || connectedPreviewBusy) return;
    setProposalApprovalBusy(true);
    setConnectedPreviewError(null);
    const epoch = proposalEpoch.current;
    const proposal = {
      proposalId: automationProposal.id,
      configurationName: configuration.name,
      lockFingerprint: configuration.lockFingerprint
    };
    const result = await window.soterStudio.beginProposalConnectedApproval({
      proposal,
      preview: connectedPreview
    }).catch((): ProposalConnectedApprovalResult => ({
      ok: false,
      error: {
        code: 'PROPOSAL_CONNECTED_APPROVAL_ADAPTER_UNAVAILABLE',
        message: 'The exact connected approval request is unavailable.'
      }
    }));
    if (proposalEpoch.current !== epoch) return;
    if (!result.ok) {
      setConnectedPreviewError(result.error);
      setProposalApprovalBusy(false);
      return;
    }
    proposalEpoch.current += 1;
    setInspection(result.inspection);
    setPreparedWork(null);
    setReviewMaterial(null);
    setReviewError(null);
    setDerivedReviewMaterial(null);
    setDerivedReviewError(null);
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    clearProposalConnectedState();
    setApprovalReviewMaterial(null);
    setApprovalReviewError(null);
    const privateReview = await loadConnectedApprovalReview(result.inspection);
    setApprovalReviewMaterial(privateReview.ok ? privateReview.material : null);
    setApprovalReviewError(privateReview.ok ? null : privateReview.error);
    setScopeConfirmed(false);
  }

  function endAutomationProposalReview() {
    proposalEpoch.current += 1;
    setAutomationProposal(null);
    setAutomationProposalMaterial(null);
    setAutomationProposalError(null);
    setAutomationProposalMaterialError(null);
    setProposalBusy(false);
    clearProposalConnectedState();
  }

  if (!scenario) {
    return <div className="empty-view"><span className="empty-shape">◇</span><h1>No operator templates</h1><p>This automation publishes no operator-visible scenario.</p></div>;
  }

  return (
    <div className="operator-view">
      <header className="operator-intro">
        <div>
          <span className="eyebrow">Operator workspace · canonical projection</span>
          <h1>{workflow.label}</h1>
          <p>{workflow.summary}</p>
        </div>
        <div className="operator-mode-stamp">
          <span>{automationProposal ? 'Selected private proposal' : inspection || preparedWork ? 'Local private activity' : 'Sanitized lifecycle example'}</span>
          <strong>{currentState === 'ready-for-acquisition' ? 'staged for acquisition' : currentState.replaceAll('-', ' ')}</strong>
          <code>{configuration?.name || 'not configured'}</code>
        </div>
      </header>

      <section className="operator-boundary" aria-label="Operator authority boundary">
        <div>
          <span className="eyebrow">Authority boundary</span>
          <strong>{automationProposal ? 'Automation and Core own this review-only proposal' : stagedAcquisition ? 'Core owns this private acquisition staging receipt' : preparedWork ? 'Core owns this private preparation receipt' : inspection ? 'Core owns this exact transaction' : 'Example only · no authority'}</strong>
          <p>{automationProposal
            ? 'Studio renders one sanitized Automation review and a separately fetched selected-proposal folio. Neither creates operational authority.'
            : stagedAcquisition
              ? 'Studio renders the exact staged input and lock binding. No provider call, context acquisition, approval, continuation, readiness, or execution exists.'
            : preparedWork
              ? 'Studio renders sanitized input, contained context, preview, and evidence facts. The receipt stops before approval or writes.'
              : inspection
                ? 'Studio renders one sanitized operator-inspection snapshot. Approval and one-time start remain separate Core operations.'
                : 'The lifecycle selector demonstrates supported UI states. It cannot approve, start, continue, or prove provider behavior.'}</p>
        </div>
        <BoundaryFact label="Valid" state={snapshot.proof.states.valid} />
        <BoundaryFact label="Ready" state={snapshot.proof.states.ready} />
        <BoundaryFact label="Verified" state={snapshot.proof.states.verified} />
        <StateMark state={currentState} />
      </section>

      <div className="operator-workbench">
        <section className="operator-orders" aria-label="Operator work selection">
          <SheetHeading eyebrow="Choose work" title="Automation templates" count={workflow.scenarios.length} />
          <div className="operator-order-list">
            {workflow.scenarios.map((item, index) => (
              <button key={item.id} type="button" className={item.id === scenario.id ? 'active' : ''} aria-pressed={item.id === scenario.id} onClick={() => setSelectedScenarioId(item.id)}>
                <span>W{String(index + 1).padStart(2, '0')}</span>
                <strong>{readable(item.id)}</strong>
                <small>{item.outcomes.length} outcomes · {item.invariants.length} safeguards</small>
                <StateMark state={item.execution?.result || item.status} compact />
              </button>
            ))}
          </div>
          <div className="operator-queue-heading"><span className="eyebrow">Lifecycle coverage</span><code>{lifecycleFixture.states.length}</code></div>
          <ul className="operator-state-matrix" aria-label="Sanitized operator lifecycle examples">
            {lifecycleFixture.states.map((item) => (
              <li key={item.id}>
                <button type="button" className={!inspection && !preparedWork && !automationProposal && item.id === example.id ? 'active' : ''} aria-pressed={!inspection && !preparedWork && !automationProposal && item.id === example.id} onClick={() => { proposalEpoch.current += 1; setInspection(null); setPreparedWork(null); setReviewMaterial(null); setReviewError(null); setDerivedReviewMaterial(null); setDerivedReviewError(null); setApprovalReviewMaterial(null); setApprovalReviewError(null); setAutomationProposal(null); setAutomationProposalMaterial(null); setAutomationProposalError(null); setAutomationProposalMaterialError(null); clearProposalConnectedState(); setSelectedExampleId(item.id); setError(null); }}>
                  <StateMark state={item.workState} compact /><span>{item.id.replaceAll('-', ' ')}</span>
                </button>
              </li>
            ))}
          </ul>
          <footer>
            <span className="eyebrow">Contained evidence</span>
            <strong>{fixtureRuns.length} exact fixture rehearsals</strong>
            <p>Fixture and runtime activity remain visibly separate.</p>
          </footer>
        </section>

        <section className="work-passage" aria-label="Operator transaction passage">
          <SheetHeading eyebrow={automationProposal ? 'Selected review-only proposal' : inspection || preparedWork ? 'Selected private activity' : 'Example state'} title={currentState.replaceAll('-', ' ')} count={automationProposal?.review.collections.length || preparedWork?.contextPlan.length || view.steps.length} />
          {loading ? <p className="operator-loading">Loading canonical operator inspection…</p> : (
            automationProposal && configuration?.lockFingerprint ? <AutomationProposalDossier
              proposal={automationProposal}
              material={automationProposalMaterial}
              error={automationProposalMaterialError}
              configurationName={configuration.name}
              lockFingerprint={configuration.lockFingerprint}
              selectedActionIds={proposalSelection}
              selectionDisabled={!proposalMaterialReady || connectedPreviewBusy || proposalApprovalBusy}
              connectedPreview={connectedPreview}
              onToggleAction={toggleProposalAction}
              onClose={endAutomationProposalReview}
            /> : preparedWork ? <PreparedWorkDossier
              work={preparedWork}
              reviewMaterial={reviewMaterial}
              reviewError={reviewError}
              derivedReviewMaterial={derivedReviewMaterial}
              derivedReviewError={derivedReviewError}
              inputFields={workflow.operator?.inputContract.fields || []}
            /> : <>
              <LifecycleStrip state={view.workState} phase={view.phase} />
              <section className="operator-canonical-scope" aria-label="Exact scope ledger">
                <header><div><span className="eyebrow">Exact scope ledger</span><strong>{view.scope.changeSetId}</strong><small>{view.scope.recordIds.length} affected records · private values withheld</small></div><StateMark state={view.applicability} compact /></header>
                <div className="operator-scope-identifiers">
                  <Fingerprint label="Lock" value={view.scope.lockFingerprint} />
                  <Fingerprint label="Change set" value={view.scope.changeSetFingerprint} />
                  <Fingerprint label="Batch" value={view.scope.batchFingerprint} />
                  <Fingerprint label="Approval request" value={view.scope.requestFingerprint} />
                </div>
                <div className="operator-scope-tokens"><TokenGroup label="Effects" values={view.scope.effects} /><TokenGroup label="Authorities" values={view.scope.authorities} /></div>
                <div className="operator-scope-records">
                  <header><span>Affected record identities</span><code>{view.scope.recordIds.length}</code></header>
                  {view.scope.recordIds.length ? <ol>{view.scope.recordIds.map((recordId) => <li key={recordId}><code>{recordId}</code></li>)}</ol> : <p>Record identities are unavailable in this projection.</p>}
                </div>
                <div className="operator-change-ledger">
                  {view.scope.changes.map((change) => (
                    <article key={change.id}>
                      <header><code>{change.id}</code><span>{change.recordId || 'record unavailable'}</span></header>
                      <div><Fingerprint label="Before" value={change.beforeFingerprint} /><Fingerprint label="After" value={change.afterFingerprint} /></div>
                    </article>
                  ))}
                </div>
              </section>

              {inspection && <ConnectedApprovalReview inspection={inspection} material={approvalReviewMaterial} error={approvalReviewError} />}

              <section className="operator-runtime-desk" aria-label="Capability and recovery state">
                <header><div><span className="eyebrow">Capability passage</span><strong>{view.phase}</strong></div><StateMark state={view.workState} compact /></header>
                <ol className="operator-step-tape">
                  {view.steps.map((step) => (
                    <li key={step.id} className={`step-${step.state}`} aria-current={step.current ? 'step' : undefined}>
                      <span className="operator-step-index">{String(step.sequence).padStart(2, '0')}</span>
                      <div><strong>{step.capability}</strong><small>{step.authority}</small></div>
                      <span className="operator-step-state">{step.state}</span>
                    </li>
                  ))}
                </ol>
                <RecoveryBrief
                  view={view}
                  privateActivity={Boolean(inspection)}
                  busy={actionBusy}
                  onPrepareReconciliation={prepareReconciliation}
                />
                <div className="operator-runtime-ledgers">
                  <VerificationLedger verification={view.verification} />
                  <CompensationLedger compensation={view.compensation} />
                </div>
              </section>
            </>
          )}
        </section>

        <aside className="operator-action-desk" aria-label="Operator action desk">
          <SheetHeading eyebrow="Action desk" title="Review and request" />
          {workflow.operator ? (
            <section className="operator-input-contract" aria-label="Declared operator inputs">
              <header><span className="operator-desk-index">A</span><div><strong>Pack-owned input contract</strong><code>{workflow.operator.inputContract.id}</code></div></header>
              {workflow.operator.inputContract.fields.map((field) => (
                <OperatorInputControl key={field.id} field={field} value={input[field.id]} onChange={(value) => setInput((current) => ({ ...current, [field.id]: value }))} />
              ))}
              <div className="operator-preparation-modes" aria-label="Canonical preparation modes">
                {containedMode && (
                  <article>
                    <header><strong>Contained fixture review</strong><code>{containedMode.resultState}</code></header>
                    <p>{containedMode.boundary}</p>
                    <button
                      className="operator-prepare-button"
                      type="button"
                      disabled={!canPrepareContained || actionBusy}
                      onClick={() => prepareRun('contained')}
                    >
                      {preparationBusy === 'contained' ? 'Preparing contained run…' : 'Prepare contained run'}
                    </button>
                  </article>
                )}
                {connectedMode && (
                  <article className="connected-acquisition-mode">
                    <header>
                      <strong>Connected acquisition staging</strong>
                      <StateMark state={connectedMode.availability.state} compact />
                    </header>
                    <p>{connectedMode.boundary}</p>
                    {connectedMode.availability.state === 'available' ? (
                      <button
                        className="operator-prepare-button operator-stage-button"
                        type="button"
                        disabled={!canStageConnectedAcquisition || actionBusy}
                        onClick={() => prepareRun('connected-acquisition')}
                      >
                        {preparationBusy === 'connected-acquisition' ? 'Staging connected acquisition…' : 'Stage connected acquisition'}
                      </button>
                    ) : (
                      <small>
                        {connectedMode.availability.reasonCode} · {connectedMode.availability.reason}
                      </small>
                    )}
                    {connectedMode.availability.state === 'available' && !canStageConnectedAcquisition && (
                      <small>Requires this canonical mode and an exact private-active configuration binding.</small>
                    )}
                  </article>
                )}
              </div>
              <small>{workflow.operator.preparation.supported
                ? 'Each action names its canonical mode. Studio never infers connected staging from the configuration basis.'
                : 'This Automation has no canonical prepared-work adapter. Input controls create no transition authority.'}</small>
            </section>
          ) : <section className="operator-input-gap"><span className="operator-desk-index">A</span><div><strong>Input contract unavailable</strong><p>Studio will not invent automation fields.</p></div></section>}

          {exactProposalRoute && (
            <section className="proposal-access" aria-label={`Exact ${exactProposalRoute.label} proposal access`}>
              <header><span className="operator-desk-index">R</span><div><strong>Open review-only proposal</strong><code>selected proposal · local private state</code></div></header>
              <label htmlFor="operator-proposal-id">Exact proposal ID</label>
              <input id="operator-proposal-id" type="text" value={proposalId} placeholder={exactProposalRoute.placeholder} onChange={(event) => {
                proposalEpoch.current += 1;
                setProposalId(event.target.value);
                setAutomationProposal(null);
                setAutomationProposalMaterial(null);
                setAutomationProposalError(null);
                setAutomationProposalMaterialError(null);
                clearProposalConnectedState();
                setProposalBusy(false);
              }} />
              <button type="button" disabled={!proposalId.trim() || !configuration?.lockFingerprint || proposalBusy} onClick={inspectAutomationProposal}>{proposalBusy ? 'Opening selected proposal…' : 'Inspect selected proposal'}</button>
              <small>This exact-ID read does not discover work, create a proposal, commit a decision, select a subset, or grant approval.</small>
              {automationProposalError && <div className="proposal-access-error" role="alert"><strong>{automationProposalError.code}</strong><p>{automationProposalError.message}</p></div>}
            </section>
          )}

          {automationProposal ? <section className="proposal-connected-gate" aria-label="Exact connected subset gate">
            <header>
              <span className="operator-desk-index">S</span>
              <div><span className="eyebrow">Exact connected subset</span><strong>Selection precedes authority</strong><p>Choose only sanitized proposed action IDs. Core recompiles the exact subset before an approval request can exist.</p></div>
            </header>
            <ol className="proposal-gate-steps" aria-label="Connected subset stages">
              <li className={proposalSelection.length ? 'is-current' : ''}><span>01</span><strong>Selected IDs</strong><small>{proposalSelection.length || 'none'}</small></li>
              <li className={connectedPreview ? 'is-current' : ''}><span>02</span><strong>Core preview</strong><small>{connectedPreview ? 'compiled' : 'not compiled'}</small></li>
              <li><span>03</span><strong>Approval request</strong><small>not created</small></li>
            </ol>
            <div className="proposal-gate-boundary">
              <span>Current authority</span>
              <strong>none</strong>
              <code>{connectedPreview?.authority.reasonCode || automationProposal.authority.reasonCode}</code>
            </div>
            <button type="button" disabled={!proposalMaterialReady || proposalSelection.length === 0 || connectedPreviewBusy || proposalApprovalBusy} onClick={previewProposalConnectedSubset}>
              {connectedPreviewBusy ? 'Compiling exact scope…' : connectedPreview ? 'Recompile exact connected scope' : 'Preview exact connected scope'}
            </button>
            {!proposalMaterialReady && <small>Exact selected-proposal private material must bind before Core can compile a connected scope.</small>}
            {connectedPreview && <button type="button" className="proposal-request-approval" disabled={proposalApprovalBusy || connectedPreviewBusy} onClick={beginProposalApproval}>{proposalApprovalBusy ? 'Creating exact request…' : 'Request exact approval'}</button>}
            {connectedPreview && <small>Requesting approval creates the canonical request family only. It does not confirm, consume, start, call a provider, or write.</small>}
            {connectedPreviewError && <div className="proposal-connected-error" role="alert"><strong>{connectedPreviewError.code}</strong><p>{connectedPreviewError.message}</p></div>}
          </section> : <section className={`operator-confirmation-ceremony confirmation-${preparedWork ? 'prepared' : view.approvalState}`} aria-label="Two-step approval ceremony">
            <div className="operator-scope-seal" aria-hidden="true"><i /><span>{preparedWork?.preview.proposedChanges.length ?? view.scope.changes.length}</span></div>
            <div className="operator-confirmation-copy">
              <span className="eyebrow">Canonical approval</span>
              <strong>{preparedWork ? 'No approval request' : approvalTitle(view.approvalState)}</strong>
              <p>{preparedWork ? preparedWork.approval.reason : inspection ? view.approvalReason : 'This sanitized example is display-only. Select local private activity to perform an available Core action.'}</p>
              {!preparedWork && <div className="operator-approval-window">
                <span>Request</span><code>{view.approval.requestId}</code>
                <span>Expires</span><time>{view.approval.expiresAt ? formatTime(view.approval.expiresAt) : 'unavailable'}</time>
              </div>}
              {inspection && <div className="approval-decision-cut"><span>Private review fact</span><i aria-hidden="true" /><strong>Separate Core decision</strong></div>}
              {preparedWork && preparedWork.preview.proposedChanges.length === 0 && <small>{preparedHeldReasonCodes.length
                ? `0 proposed changes · held · ${preparedHeldReasonCodes.join(' · ')}`
                : preparedWork.preview.kind === 'meeting-intake-review'
                  ? '0 proposed changes · judgment not performed'
                : preparedWork.effects.some((effect) => effect.effect === 'write')
                  ? '0 proposed changes · write not proposed'
                  : '0 proposed changes · read-only review'}</small>}
              {inspection?.approval.state === 'awaiting' && (
                <>
                  <label className="operator-confirmation-check"><input type="checkbox" checked={scopeConfirmed} onChange={(event) => setScopeConfirmed(event.target.checked)} /><span>I reviewed the exact lock, batch, change set, effects, authorities, and affected records.</span></label>
                  <button type="button" disabled={!scopeConfirmed || actionBusy || inspection.configuration.applicability.state !== 'current'} onClick={confirmApproval}>{actionBusy ? 'Recording approval…' : 'Approve exact request'}</button>
                </>
              )}
              {inspection?.approval.state === 'confirmed' && inspection.approval.confirmation && (
                <button type="button" disabled={actionBusy || inspection.configuration.applicability.state !== 'current'} onClick={startTransaction}>{actionBusy ? 'Creating checkpoint…' : 'Consume approval + start'}</button>
              )}
              {inspection?.approval.confirmation && <small>{inspection.approval.confirmation.id} · {inspection.approval.confirmation.actor}</small>}
              {connectedActionError && (
                <div className="proposal-connected-error" role="alert">
                  <strong>{connectedActionError.code}</strong>
                  {connectedActionError.reasonCode && <code>{connectedActionError.reasonCode}</code>}
                  <p>{connectedActionError.message}</p>
                </div>
              )}
              {error && <p className="operator-confirmation-error" role="alert">{error}</p>}
            </div>
          </section>}

          <section className="operator-review-list">
            <span className="eyebrow">What remains distinct</span>
            <ul>
              <li><span>Approval</span><strong>{automationProposal ? connectedPreview ? 'previewed · not requested' : 'not created' : preparedWork?.approval.state || view.approvalState}</strong></li>
              <li><span>Checkpoint</span><strong>{automationProposal ? 'not created' : preparedWork?.checkpoint.state || view.checkpointState || 'not created'}</strong></li>
              <li><span>Verification</span><strong>{automationProposal ? connectedPreview ? 'declared · not executed' : 'not evaluated' : preparedWork ? 'not evaluated' : view.verification.state}</strong></li>
              <li><span>Compensation</span><strong>{automationProposal || preparedWork ? 'not created' : view.compensation.state}</strong></li>
              <li><span>Proof family</span><strong>{inspection?.families.proof.state || 'not evaluated'}</strong></li>
            </ul>
          </section>
          <footer><span>Responsibility boundary</span><code>{automationProposal ? 'Automation proposal → exact IDs → Core preview → separate request' : 'pack inputs → local Core preparation → sanitized Studio projection'}</code><p>{automationProposal ? 'Studio holds the selected IDs and Core-returned preview transiently. Private proposal values are cleared when selection ends and never enter workspace inspection, evidence, proof, logs, or general renderer state.' : 'Private inputs originate in this renderer and are sent only to the trusted local Core preparation operation. They are never returned through inspection, evidence, or the prepared-work projection.'}</p></footer>
        </aside>
      </div>
    </div>
  );
}

function inspectionView(inspection: OperatorInspection) {
  return {
    workState: inspection.activity.workState,
    phase: inspection.activity.phase,
    applicability: inspection.configuration.applicability.state,
    approvalState: inspection.approval.state,
    approvalReason: inspection.resume.reason,
    checkpointState: inspection.checkpoint?.state || null,
    approval: {
      requestId: inspection.approval.request.id,
      requestedAt: inspection.approval.request.requestedAt,
      expiresAt: inspection.approval.request.expiresAt,
      confirmationId: inspection.approval.confirmation?.id || null,
      consumptionId: inspection.approval.consumption?.id || null
    },
    checkpoint: inspection.checkpoint,
    continuationRequest: inspection.continuationRequest,
    blockers: inspection.blockers,
    verification: inspection.verification,
    compensation: inspection.compensation,
    resume: inspection.resume,
    scope: {
      lockFingerprint: inspection.configuration.lockFingerprint,
      changeSetId: inspection.scope.changeSet.id,
      changeSetFingerprint: inspection.scope.changeSet.fingerprint,
      batchFingerprint: inspection.scope.batch.fingerprint,
      requestFingerprint: inspection.approval.request.fingerprint,
      effects: inspection.scope.effects,
      authorities: inspection.scope.authorities,
      recordIds: inspection.scope.recordIds,
      changes: inspection.scope.changes
    },
    steps: inspection.capabilities.steps.map((step) => ({ ...step, current: inspection.capabilities.current?.stepId === step.id })),
    completedPrefix: inspection.capabilities.completedPrefix,
    current: inspection.capabilities.current,
    pending: inspection.capabilities.pending
  };
}

function exampleView(example: ExampleState) {
  const scope = lifecycleFixture.scope;
  return {
    workState: example.workState,
    phase: example.phase,
    applicability: example.id === 'checkpoint-stale' ? 'stale' : 'current',
    approvalState: example.approvalState,
    approvalReason: example.resume.reason,
    checkpointState: example.checkpointState,
    approval: {
      requestId: scope.approvalRequestId,
      requestedAt: null,
      expiresAt: null,
      confirmationId: null,
      consumptionId: null
    },
    checkpoint: example.checkpointState ? {
      id: 'checkpoint.example.connected-transaction',
      fingerprint: null,
      state: example.checkpointState,
      updatedAt: null
    } : null,
    continuationRequest: null,
    blockers: [],
    verification: {
      state: example.verificationState as OperatorInspection['verification']['state'],
      criteria: scope.verificationCriterionIds.map((id) => ({
        id,
        state: example.verificationState === 'failed' ? 'failed' : example.verificationState === 'verified' ? 'passed' : 'pending',
        reasonCode: example.verificationState === 'failed' ? 'READ_AFTER_WRITE_MISMATCH' : example.verificationState === 'verified' ? 'VERIFICATION_PASSED' : 'VERIFICATION_PENDING',
        observedFingerprint: null
      })),
      observedFingerprint: null
    },
    compensation: {
      state: example.compensationState as OperatorInspection['compensation']['state'],
      plan: [],
      completedStepIds: [],
      remainingStepIds: [],
      restoredFingerprint: null
    },
    resume: example.resume,
    scope: {
      lockFingerprint: scope.configurationLockFingerprint,
      changeSetId: scope.changeSetId,
      changeSetFingerprint: scope.changeSetFingerprint,
      batchFingerprint: scope.batchFingerprint,
      requestFingerprint: scope.approvalRequestFingerprint,
      effects: scope.effects,
      authorities: scope.authorities,
      recordIds: scope.recordIds,
      changes: scope.changes.map((item) => ({ ...item, effect: 'write' }))
    },
    steps: scope.changes.map((change, index) => ({ id: change.id, sequence: index + 1, capability: 'crm.records.update', authority: scope.authorities[0], state: example.checkpointState ? index ? 'pending' : 'current' : 'pending', current: Boolean(example.checkpointState && index === 0) })),
    completedPrefix: [],
    current: null,
    pending: scope.changes.map((item) => item.id)
  };
}

function LifecycleStrip({ state, phase }: { state: string; phase: string }) {
  const phases = ['preparation', 'approval', 'execution', 'reconciliation', 'verification', 'complete'];
  return <ol className="operator-lifecycle-strip" aria-label="Projected operator lifecycle">{phases.map((item, index) => <li key={item} className={item === phase ? 'current' : ''} aria-current={item === phase ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item}</strong>{item === phase && <small>{state}</small>}</li>)}</ol>;
}

function SheetHeading({ eyebrow, title, count }: { eyebrow: string; title: string; count?: number }) {
  return <div className="operator-sheet-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{count !== undefined && <code>{count}</code>}</div>;
}

function BoundaryFact({ label, state }: { label: string; state: string }) {
  return <div className="operator-boundary-fact"><span>{label}</span><StateMark state={state} compact /></div>;
}

function Fingerprint({ label, value }: { label: string; value: string | null }) {
  return <p className="operator-runtime-fingerprint"><span>{label}</span><code>{value || 'unavailable'}</code></p>;
}

function TokenGroup({ label, values }: { label: string; values: string[] }) {
  return <div><span>{label}</span>{values.map((value) => <code key={value}>{value}</code>)}</div>;
}

function RecoveryBrief({
  view,
  privateActivity,
  busy,
  onPrepareReconciliation
}: {
  view: ReturnType<typeof inspectionView> | ReturnType<typeof exampleView>;
  privateActivity: boolean;
  busy: boolean;
  onPrepareReconciliation: () => void;
}) {
  const canPrepareReconciliation = privateActivity
    && view.continuationRequest?.kind === 'prepare-reconciliation'
    && view.resume.classification === 'safe';
  const hasContinuation = privateActivity && Boolean(view.continuationRequest);
  const actionLabel = canPrepareReconciliation
    ? busy ? 'Preparing exact read…' : 'Prepare read-only reconciliation'
    : view.continuationRequest?.kind === 'execute-current-call'
      ? 'Continue through configured host'
      : 'No executable continuation';
  return (
    <section className={`operator-recovery-brief${view.blockers.length ? ' has-blocker' : ''}`} aria-label="Exact checkpoint recovery">
      <header>
        <div><span className="eyebrow">Exact checkpoint recovery</span><strong>{view.checkpoint ? view.checkpoint.state.replaceAll('-', ' ') : 'No checkpoint created'}</strong></div>
        <StateMark state={view.resume.classification} compact />
      </header>
      <div className="operator-recovery-progress">
        <RecoveryColumn label="Completed prefix" state={view.completedPrefix.length ? 'passed' : 'unknown'} values={view.completedPrefix} empty="No completed steps projected." />
        <RecoveryColumn label="Exact current step" state={view.current ? 'current' : 'unknown'} values={view.current ? [view.current.stepId, view.current.stage, view.current.callId] : []} count={view.current ? 1 : 0} empty="No current call projected." />
        <RecoveryColumn label="Remaining" state={view.pending.length ? 'pending' : 'passed'} values={view.pending} empty="No pending steps projected." />
      </div>
      {view.blockers.length > 0 && <div className="operator-recovery-requirements">
        {view.blockers.map((blocker) => <article key={blocker.reasonCode}>
          <p><code>{blocker.reasonCode}</code>{blocker.summary}</p>
          {blocker.requiredInputs.length > 0 && <RecoveryRequirement label="Missing input" values={blocker.requiredInputs} />}
          {blocker.requiredPermissions.length > 0 && <RecoveryRequirement label="Permission" values={blocker.requiredPermissions} />}
          {blocker.details.length > 0 && <RecoveryRequirement label="Observed fact" values={blocker.details.map((item) => `${item.key}: ${item.value ?? 'unavailable'}`)} />}
        </article>)}
      </div>}
      <div className="operator-resume-decision">
        <span className="operator-checkpoint-mark" aria-hidden="true">↺<i /></span>
        <div className="operator-resume-copy">
          <span className="eyebrow">Core-derived resume decision</span>
          <strong>{view.resume.reasonCode}</strong>
          <p>{view.resume.reason}</p>
          <span className="operator-permitted-action">Display guidance <code>{view.resume.permittedNextAction}</code></span>
          <code>{view.checkpoint?.id || 'checkpoint unavailable'}</code>
          {view.continuationRequest && <small>{view.continuationRequest.kind} · {view.continuationRequest.requestFingerprint}</small>}
        </div>
        <button type="button" disabled={!canPrepareReconciliation || busy} onClick={onPrepareReconciliation}>{actionLabel}</button>
        <small>{canPrepareReconciliation
          ? 'Core will prepare one bounded read-only observation. Studio will not execute the provider call.'
          : hasContinuation
            ? 'The separately fingerprinted request exists, but provider execution remains a configured-host responsibility.'
            : 'Descriptive guidance alone cannot authorize recovery or replay a write.'}</small>
      </div>
    </section>
  );
}

function RecoveryColumn({ label, state, values, count = values.length, empty }: { label: string; state: string; values: string[]; count?: number; empty: string }) {
  return <section className={`operator-recovery-step recovery-${state}`}><header><span>{label}</span><code>{count}</code></header>{values.length ? <ol>{values.map((value) => <li key={value}><code>{value}</code></li>)}</ol> : <p>{empty}</p>}</section>;
}

function RecoveryRequirement({ label, values }: { label: string; values: string[] }) {
  return <div className="operator-recovery-requirement"><span>{label}</span><div>{values.map((value) => <code key={value}>{value}</code>)}</div></div>;
}

function VerificationLedger({ verification }: { verification: ReturnType<typeof inspectionView>['verification'] }) {
  return <section className="operator-runtime-ledger"><header><span>Verification</span><StateMark state={verification.state} compact /></header><div>{verification.criteria.length ? verification.criteria.map((criterion) => <article className={`criterion-${criterion.state}`} key={criterion.id}><code>{criterion.reasonCode}</code><strong>{criterion.id}</strong><p>{criterion.state} · observed fingerprint {criterion.observedFingerprint || 'unavailable'}</p></article>) : <p className="operator-ledger-empty">No verification criteria projected.</p>}</div></section>;
}

function CompensationLedger({ compensation }: { compensation: ReturnType<typeof inspectionView>['compensation'] }) {
  return <section className="operator-runtime-ledger"><header><span>Compensation</span><StateMark state={compensation.state} compact /></header><div>
    {compensation.plan.length ? compensation.plan.map((step) => <p className="operator-compensation-steps" key={step.stepId}><span>{step.mode}</span><code>{step.stepId}</code></p>) : <p className="operator-ledger-empty">No compensation plan projected.</p>}
    <Fingerprint label="Restored" value={compensation.restoredFingerprint} />
  </div></section>;
}

function approvalTitle(state: string) {
  const titles: Record<string, string> = { awaiting: 'Awaiting exact approval', expired: 'Approval request expired', confirmed: 'Approved · not started', consumed: 'Approval consumed once', 'not-issued': 'Prepared work · request unavailable' };
  return titles[state] || state.replaceAll('-', ' ');
}

function isContainedPreparationMode(
  mode: OperatorPreparationMode
): mode is Extract<OperatorPreparationMode, { id: 'contained' }> {
  return mode.id === 'contained'
    && mode.resultState === 'ready-for-review'
    && exactAvailability(mode.availability, 'available')
    && mode.configurationBases.length === 2
    && mode.configurationBases[0] === 'tracked-contained'
    && mode.configurationBases[1] === 'private-active';
}

function isConnectedAcquisitionMode(
  mode: OperatorPreparationMode
): mode is Extract<OperatorPreparationMode, { id: 'connected-acquisition' }> {
  return mode.id === 'connected-acquisition'
    && mode.resultState === 'ready-for-acquisition'
    && exactAvailability(mode.availability)
    && mode.configurationBases.length === 1
    && mode.configurationBases[0] === 'private-active';
}

function exactAvailability(
  value: OperatorPreparationMode['availability'],
  expectedState?: 'available'
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.state === 'available') {
    return (!expectedState || expectedState === 'available')
      && Object.keys(value).length === 1;
  }
  return !expectedState
    && value.state === 'unavailable'
    && Object.keys(value).sort().join(',') === 'reason,reasonCode,state'
    && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(value.reasonCode)
    && typeof value.reason === 'string'
    && value.reason.length >= 20;
}

function readable(value: string) {
  return value.split('.').at(-1)?.replaceAll('-', ' ') || value;
}

async function loadPreparedPrivateSurfaces(work: PreparedWork): Promise<{
  review: PreparedWorkReviewResult;
  derived: PreparedWorkDerivedReviewResult | null;
}> {
  const reviewPromise = window.soterStudio.getPreparedWorkReview({ workId: work.id })
    .catch((): PreparedWorkReviewResult => ({
      ok: false,
      error: {
        code: 'PREPARED_REVIEW_ADAPTER_UNAVAILABLE',
        message: 'Private review material is unavailable for this prepared work.'
      }
    }));
  const derivedPromise = work.preview.privateReview.state === 'available'
    ? window.soterStudio.getPreparedWorkDerivedReview({ workId: work.id })
      .catch((): PreparedWorkDerivedReviewResult => ({
        ok: false,
        error: {
          code: 'PREPARED_DERIVED_REVIEW_ADAPTER_UNAVAILABLE',
          message: 'Private derived review material is unavailable for this prepared work.'
        }
      }))
    : Promise.resolve(null);
  const [review, derived] = await Promise.all([reviewPromise, derivedPromise]);
  return { review, derived };
}

async function loadConnectedApprovalReview(inspection: OperatorInspection): Promise<ConnectedApprovalReviewResult> {
  try {
    return await window.soterStudio.getConnectedApprovalReview({ requestId: inspection.approval.request.id });
  } catch {
    return {
      ok: false,
      error: {
        code: 'CONNECTED_APPROVAL_REVIEW_ADAPTER_UNAVAILABLE',
        message: 'Private approval review material is unavailable for this selected activity.'
      }
    };
  }
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
