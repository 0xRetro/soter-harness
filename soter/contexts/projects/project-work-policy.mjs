import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';

const POLICY_CONTRACT = 'soter://contexts/projects/project-work-policy/v1';

export function loadProjectWorkPolicyDefinition(root) {
  const schema = readJson(path.join(
    root,
    'soter',
    'contracts',
    'project-work-policy.schema.json'
  ));
  const definition = readJson(path.join(
    root,
    'soter',
    'contexts',
    'projects',
    'project-work.policy.json'
  ));
  const failures = validateJsonSchema(definition, schema);
  if (definition.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error(
      'Project work policy definition does not satisfy its Context contract'
        + (failures.length
          ? ': ' + failures.slice(0, 5).map((item) => {
            return item.path + ' ' + item.message;
          }).join('; ')
          : '.')
    );
  }
  return definition;
}

export function projectWorkPolicyFields(definition) {
  return {
    name: definition.name,
    progressRequiresPromotedTasks: definition.progressRequiresPromotedTasks,
    milestoneWorkItemsRemainDistinct: definition.milestoneWorkItemsRemainDistinct,
    healthMustBeOperatorJudgment: definition.healthMustBeOperatorJudgment,
    writesRequireConfirmation: definition.writesRequireConfirmation,
    updateCategory: definition.updateCategory,
    defaultProcessed: definition.defaultProcessed,
    allowedUpdateCategories: structuredClone(definition.allowedUpdateCategories),
    allowedVisibilities: structuredClone(definition.allowedVisibilities),
    duplicateCandidateLimit: definition.duplicateCandidateLimit,
    doneTaskStatuses: structuredClone(definition.doneTaskStatuses),
    blockedTaskStatuses: structuredClone(definition.blockedTaskStatuses),
    notStartedTaskStatuses: structuredClone(definition.notStartedTaskStatuses),
    allowedProgressStates: structuredClone(definition.allowedProgressStates),
    allowedHealthStates: structuredClone(definition.allowedHealthStates),
    milestoneSyntaxVersion: definition.milestoneSyntaxVersion,
    workItemSyntaxVersion: definition.workItemSyntaxVersion,
    milestoneProgressRule: definition.milestoneProgressRule,
    promotionBoundary: definition.promotionBoundary,
    coordinationDisposition: definition.coordinationDisposition,
    promotionTaskContext: definition.promotionTaskContext,
    promotionMarksTrackedWorkComplete: definition.promotionMarksTrackedWorkComplete,
    decisionCategory: definition.decisionCategory,
    questionCategory: definition.questionCategory,
    decisionSummaryGrammar: definition.decisionSummaryGrammar,
    questionSummaryGrammar: definition.questionSummaryGrammar,
    missingDecisionWhyMarker: definition.missingDecisionWhyMarker,
    decisionResolutionRequiresQuestion: definition.decisionResolutionRequiresQuestion,
    decisionResolutionRequiresWorkItem: definition.decisionResolutionRequiresWorkItem
  };
}

export function assertProjectWorkPolicySelection(output, definition, {
  requireProjectedRules = false
} = {}) {
  const records = (output?.records || []).filter((record) => {
    return record.type === 'project-work-policy';
  });
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error('Project work requires one exact normalized policy-selection record.');
  }
  const record = records[0];
  const expectedFields = projectWorkPolicyFields(definition);
  const expected = requireProjectedRules ? expectedFields : { name: definition.name };
  if (fingerprintJson(record.fields) !== fingerprintJson(expected)) {
    throw new Error(
      requireProjectedRules
        ? 'Project work policy projection does not match the exact governed Context definition.'
        : 'Project work policy selection does not identify the exact governed Context definition.'
    );
  }
  return {
    record,
    fields: expectedFields,
    definitionFingerprint: fingerprintJson(definition)
  };
}
