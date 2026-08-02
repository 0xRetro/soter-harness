import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const STANDALONE_BOLD = /^(?:\*\*|__)([^*_][\s\S]*?)(?:\*\*|__)\s*:?\s*$/;
const STRUCTURAL_PATTERNS = {
  database: /<(?:database|collection_view)(?:\s|\/|>)/gi,
  callout: /<callout(?:\s|\/|>)/gi,
  columns: /<(?:columns|column_list)(?:\s|\/|>)/gi
};
const INFORMATIONAL_REASON_CODES = new Set([
  'PROJECT_PAGE_MANAGER_IDENTITY_UNAVAILABLE',
  'PROJECT_PAGE_PROVIDER_LIVE_VIEW_WIRING_UNAVAILABLE',
  'PROJECT_PAGE_TYPE_NOT_SET_ALLOWED',
  'PROJECT_TASK_ASSIGNEE_UNASSIGNED_ALLOWED'
]);

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanLabel(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function projectPageReviewAttention(reasonCodes) {
  if (!Array.isArray(reasonCodes)
    || reasonCodes.some((code) => typeof code !== 'string' || !code)) {
    throw new Error('Project-page review attention requires exact reason codes.');
  }
  return reasonCodes.some((code) => {
    return !INFORMATIONAL_REASON_CODES.has(code) && !code.endsWith('_FIELD_UNAVAILABLE');
  })
    ? 'operator'
    : 'no-one';
}

function stripFencedMarkdown(body) {
  const visible = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    if (!fence) {
      const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) {
        fence = { marker: opening[1][0], length: opening[1].length };
        continue;
      }
      visible.push(line);
      continue;
    }
    const closing = new RegExp(
      '^\\s{0,3}' + (fence.marker === '`' ? '`' : '~')
        + '{' + String(fence.length) + ',}\\s*$'
    );
    if (closing.test(line)) fence = null;
  }
  return visible.join('\n');
}

export function normalizeProjectPageOutline(body, {
  maximumOutlineEntries = 100
} = {}) {
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('Project-page review requires one non-empty normalized Markdown body.');
  }
  const entries = [];
  for (const line of stripFencedMarkdown(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    const heading = HEADING.exec(trimmed);
    if (heading) {
      const label = cleanLabel(heading[2]);
      if (label) entries.push({ kind: 'heading', level: heading[1].length, label });
      continue;
    }
    const bold = STANDALONE_BOLD.exec(trimmed);
    if (bold) {
      const label = cleanLabel(bold[1]);
      if (label) entries.push({ kind: 'label', level: 0, label });
    }
  }
  if (entries.length > maximumOutlineEntries) {
    throw new Error('Project-page semantic outline exceeds the configured bounded matcher limit.');
  }
  return entries;
}

function outlineKey(entry) {
  return entry.kind + ':' + String(entry.level) + ':' + entry.label.toLowerCase();
}

function withoutDocumentTitle(entries) {
  const firstHeadingIndex = entries.findIndex((entry) => entry.kind === 'heading' && entry.level === 1);
  return firstHeadingIndex === -1
    ? entries
    : entries.filter((_, index) => index !== firstHeadingIndex);
}

export function compareProjectPageOutlines(templateBody, pageBody, settings) {
  const template = withoutDocumentTitle(normalizeProjectPageOutline(templateBody, settings));
  const page = withoutDocumentTitle(normalizeProjectPageOutline(pageBody, settings));
  const templateKeys = template.map(outlineKey);
  const pageKeys = page.map(outlineKey);
  const occurrenceCounts = (values) => values.reduce((counts, value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map());
  const unmatched = (entries, availableKeys) => {
    const available = occurrenceCounts(availableKeys);
    return entries.filter((entry) => {
      const key = outlineKey(entry);
      const remaining = available.get(key) || 0;
      if (!remaining) return true;
      available.set(key, remaining - 1);
      return false;
    });
  };
  const sharedSequence = (keys, availableKeys) => {
    const available = occurrenceCounts(availableKeys);
    return keys.filter((key) => {
      const remaining = available.get(key) || 0;
      if (!remaining) return false;
      available.set(key, remaining - 1);
      return true;
    });
  };
  const missing = unmatched(template, pageKeys);
  const extra = unmatched(page, templateKeys);
  const commonTemplate = sharedSequence(templateKeys, pageKeys);
  const commonPage = sharedSequence(pageKeys, templateKeys);
  const orderDrift = fingerprintJson(commonTemplate) !== fingerprintJson(commonPage);
  return {
    template,
    page,
    missing,
    extra,
    orderDrift,
    templateFingerprint: fingerprintJson(template),
    pageFingerprint: fingerprintJson(page)
  };
}

export function normalizedProjectPageStructure(body) {
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('Project-page structural review requires one non-empty normalized body.');
  }
  const counts = Object.fromEntries(Object.entries(STRUCTURAL_PATTERNS).map(([kind, pattern]) => {
    pattern.lastIndex = 0;
    return [kind, [...stripFencedMarkdown(body).matchAll(pattern)].length];
  }));
  return {
    counts,
    fingerprint: fingerprintJson(counts)
  };
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item);
  }
  return typeof value === 'string' && value ? [value] : [];
}

function exactTaskCoverage(expectedValues, tasks, mode) {
  if (!['require-complete', 'allow-incomplete-no-authority'].includes(mode)) {
    throw new Error('Project-page review requires one exact Task coverage mode.');
  }
  const expectedIds = [...expectedValues].sort(compareCodepoint);
  const observedIds = tasks.map((task) => task.id).sort(compareCodepoint);
  if (new Set(observedIds).size !== observedIds.length) {
    throw new Error('Project-page review rejects duplicate observed Task identities.');
  }
  const expected = new Set(expectedIds);
  if (observedIds.some((id) => !expected.has(id))) {
    throw new Error('Project-page review rejects substituted or out-of-scope Task identities.');
  }
  const observed = new Set(observedIds);
  const unavailableIds = expectedIds.filter((id) => !observed.has(id));
  if (mode === 'require-complete' && unavailableIds.length) {
    throw new Error('Project-page review requires every and only the Tasks related by the Project.');
  }
  const base = {
    state: unavailableIds.length ? 'incomplete' : 'complete',
    reasonCode: unavailableIds.length
      ? 'PROJECT_TASK_COVERAGE_INCOMPLETE'
      : 'PROJECT_TASK_COVERAGE_COMPLETE',
    expectedCount: expectedIds.length,
    observedCount: observedIds.length,
    unavailableCount: unavailableIds.length,
    expectedIdentitySetFingerprint: fingerprintJson(expectedIds),
    observedIdentitySetFingerprint: fingerprintJson(observedIds),
    unavailableIdentitySetFingerprint: fingerprintJson(unavailableIds)
  };
  const unavailableIdentityFingerprints = unavailableIds.map((id) => fingerprintJson(id));
  return {
    ...base,
    unavailableIdentityFingerprints,
    fingerprint: fingerprintJson({
      ...base,
      unavailableIdentityFingerprints
    })
  };
}

function exactPolicySemantics(policies) {
  const projectCapture = policies?.projectCapture;
  const projectWork = policies?.projectWork;
  const taskWork = policies?.taskWork;
  const uniqueStrings = (values) => Array.isArray(values)
    && values.length > 0
    && values.every((value) => typeof value === 'string' && value)
    && new Set(values).size === values.length;
  if (!projectCapture
    || !uniqueStrings(projectCapture.allowedTypes)
    || !uniqueStrings(projectCapture.allowedStatuses)
    || typeof projectCapture.defaultStatus !== 'string'
    || !projectCapture.allowedStatuses.includes(projectCapture.defaultStatus)
    || projectCapture.projectTypePolicy !== 'optional-when-unclear'
    || projectCapture.organizationPolicy !== 'client-facing-required-internal-optional'
    || projectCapture.managerPolicy !== 'unavailable'
    || !projectWork
    || projectWork.milestoneWorkItemsRemainDistinct !== true
    || !taskWork
    || !uniqueStrings(taskWork.allowedContexts)
    || taskWork.projectRequired !== true
    || taskWork.assigneePolicy !== 'current-user-or-unassigned') {
    throw new Error(
      'Project-page review requires the exact supported Project capture, Project work, and Task work policy semantics.'
    );
  }
  const evaluated = {
    projectCapture: {
      allowedTypes: structuredClone(projectCapture.allowedTypes),
      allowedStatuses: structuredClone(projectCapture.allowedStatuses),
      defaultStatus: projectCapture.defaultStatus,
      projectTypePolicy: projectCapture.projectTypePolicy,
      organizationPolicy: projectCapture.organizationPolicy,
      managerPolicy: projectCapture.managerPolicy
    },
    projectWork: {
      milestoneWorkItemsRemainDistinct: projectWork.milestoneWorkItemsRemainDistinct
    },
    taskWork: {
      allowedContexts: structuredClone(taskWork.allowedContexts),
      projectRequired: taskWork.projectRequired,
      assigneePolicy: taskWork.assigneePolicy
    }
  };
  return {
    ...evaluated,
    fingerprint: fingerprintJson(evaluated)
  };
}

function taskReasonCodes(task, projectId, policy) {
  const fields = task.fields || {};
  const codes = [];
  const contexts = stringList(fields.context);
  if (!Object.hasOwn(fields, 'context')) {
    codes.push('PROJECT_TASK_CONTEXT_FIELD_UNAVAILABLE');
  } else if (!contexts.length) {
    codes.push('PROJECT_TASK_CONTEXT_NOT_SET');
  } else if (contexts.some((value) => !policy.allowedContexts.includes(value))) {
    codes.push('PROJECT_TASK_CONTEXT_OUT_OF_POLICY');
  }
  if (!Object.hasOwn(fields, 'nextActionOn')) {
    codes.push('PROJECT_TASK_NEXT_ACTION_ON_FIELD_UNAVAILABLE');
  } else if (!stringList(fields.nextActionOn).length) {
    codes.push('PROJECT_TASK_NEXT_ACTION_NOT_SET');
  }
  if (!Object.hasOwn(fields, 'assigneeIds')) {
    codes.push('PROJECT_TASK_ASSIGNEE_IDS_FIELD_UNAVAILABLE');
  } else if (!stringList(fields.assigneeIds).length) {
    codes.push('PROJECT_TASK_ASSIGNEE_UNASSIGNED_ALLOWED');
  }
  if (!Object.hasOwn(fields, 'projectUris')) {
    codes.push('PROJECT_TASK_RELATION_VERIFICATION_UNAVAILABLE');
  } else if (policy.projectRequired && !stringList(fields.projectUris).includes(projectId)) {
    codes.push('PROJECT_TASK_RELATION_INCONSISTENT');
  }
  return codes.sort(compareCodepoint);
}

export function analyzeProjectPageReview({
  project,
  tasks,
  document,
  templateDocument,
  settings,
  policies,
  taskCoverageMode = 'require-complete'
}) {
  if (!project || project.type !== 'project'
    || typeof project.id !== 'string'
    || typeof project.fields?.name !== 'string') {
    throw new Error('Project-page review requires one exact normalized Project record.');
  }
  if (document?.uri !== project.id
    || document.title !== project.fields.name
    || document.bodyFingerprint !== fingerprintJson(document.body)) {
    throw new Error('Project-page review requires the exact selected Project document and title.');
  }
  if (!templateDocument
    || templateDocument.bodyFingerprint !== fingerprintJson(templateDocument.body)) {
    throw new Error('Project-page review requires one exact fingerprint-bound template document.');
  }
  const policy = exactPolicySemantics(policies);
  if (!Array.isArray(tasks)) {
    throw new Error('Project-page review requires one exact normalized Task collection.');
  }
  if (!Object.hasOwn(project.fields, 'taskUris')
    || !Array.isArray(project.fields.taskUris)) {
    throw new Error(
      'Project-page review requires an explicitly available Project taskUris array.'
    );
  }
  const taskUris = project.fields.taskUris;
  if (taskUris.length > 100
    || taskUris.some((value) => typeof value !== 'string' || !value)
    || new Set(taskUris).size !== taskUris.length) {
    throw new Error('Project-page review requires at most 100 unique related Task identities.');
  }
  if (tasks.some((task) => task.type !== 'task')
    || tasks.some((task) => typeof task.id !== 'string' || !task.id)) {
    throw new Error('Project-page review requires exact normalized Task records.');
  }
  const taskCoverage = exactTaskCoverage(taskUris, tasks, taskCoverageMode);
  const outline = compareProjectPageOutlines(
    templateDocument.body,
    document.body,
    settings
  );
  const templateStructure = normalizedProjectPageStructure(templateDocument.body);
  const pageStructure = normalizedProjectPageStructure(document.body);
  const structuralDrift = Object.keys(templateStructure.counts).some((kind) => {
    return templateStructure.counts[kind] !== pageStructure.counts[kind];
  });
  const projectCodes = [];
  if (outline.missing.length) projectCodes.push('PROJECT_PAGE_TEMPLATE_ENTRY_MISSING');
  if (outline.extra.length) projectCodes.push('PROJECT_PAGE_TEMPLATE_ENTRY_EXTRA');
  if (outline.orderDrift) projectCodes.push('PROJECT_PAGE_TEMPLATE_ORDER_DRIFT');
  if (structuralDrift) projectCodes.push('PROJECT_PAGE_TEMPLATE_STRUCTURE_DRIFT');
  if (taskCoverage.state === 'incomplete') {
    projectCodes.push('PROJECT_TASK_COVERAGE_INCOMPLETE');
  }
  const projectTypes = stringList(project.fields.projectType);
  if (!Object.hasOwn(project.fields, 'projectType')) {
    projectCodes.push('PROJECT_PAGE_TYPE_FIELD_UNAVAILABLE');
  } else if (!projectTypes.length) {
    projectCodes.push('PROJECT_PAGE_TYPE_NOT_SET_ALLOWED');
  } else if (projectTypes.some((value) => !policy.projectCapture.allowedTypes.includes(value))) {
    projectCodes.push('PROJECT_PAGE_TYPE_OUT_OF_POLICY');
  }
  if (!Object.hasOwn(project.fields, 'organizationUris')) {
    projectCodes.push('PROJECT_PAGE_ORGANIZATION_URIS_FIELD_UNAVAILABLE');
  } else if (!stringList(project.fields.organizationUris).length) {
    projectCodes.push('PROJECT_PAGE_ORGANIZATION_NOT_SET');
  }
  const projectStatuses = stringList(project.fields.status);
  if (!Object.hasOwn(project.fields, 'status')) {
    projectCodes.push('PROJECT_PAGE_STATUS_FIELD_UNAVAILABLE');
  } else if (!projectStatuses.length) {
    projectCodes.push('PROJECT_PAGE_STATUS_NOT_SET');
  } else if (projectStatuses.some((value) => {
    return !policy.projectCapture.allowedStatuses.includes(value);
  })) {
    projectCodes.push('PROJECT_PAGE_STATUS_OUT_OF_POLICY');
  }
  projectCodes.push('PROJECT_PAGE_MANAGER_IDENTITY_UNAVAILABLE');
  projectCodes.push('PROJECT_PAGE_PROVIDER_LIVE_VIEW_WIRING_UNAVAILABLE');
  const taskReviews = tasks.map((task) => ({
    task,
    reasonCodes: taskReasonCodes(task, project.id, policy.taskWork),
    fingerprint: fingerprintJson({
      id: task.id,
      version: task.version,
      fields: task.fields
    })
  })).sort((left, right) => compareCodepoint(left.task.id, right.task.id));
  const hardCodes = new Set([
    'PROJECT_PAGE_TEMPLATE_ENTRY_MISSING',
    'PROJECT_PAGE_TEMPLATE_ORDER_DRIFT',
    'PROJECT_PAGE_TEMPLATE_STRUCTURE_DRIFT',
    'PROJECT_PAGE_TYPE_OUT_OF_POLICY',
    'PROJECT_PAGE_STATUS_OUT_OF_POLICY',
    'PROJECT_TASK_CONTEXT_OUT_OF_POLICY',
    'PROJECT_TASK_COVERAGE_INCOMPLETE',
    'PROJECT_TASK_RELATION_VERIFICATION_UNAVAILABLE',
    'PROJECT_TASK_RELATION_INCONSISTENT'
  ]);
  const hardFindingCount = projectCodes.filter((code) => hardCodes.has(code)).length
    + taskReviews.reduce((sum, review) => {
      return sum + review.reasonCodes.filter((code) => hardCodes.has(code)).length;
    }, 0);
  const operatorAttention = projectPageReviewAttention(projectCodes) === 'operator'
    || taskReviews.some((review) => {
      return projectPageReviewAttention(review.reasonCodes) === 'operator';
    });
  return {
    state: operatorAttention ? 'attention-required' : 'reviewed',
    project: {
      record: project,
      fingerprint: fingerprintJson({
        id: project.id,
        version: project.version,
        fields: project.fields
      }),
      reasonCodes: projectCodes.sort(compareCodepoint)
    },
    document,
    templateDocument,
    outline,
    structure: {
      template: templateStructure,
      page: pageStructure,
      drift: structuralDrift
    },
    policy,
    taskCoverage,
    tasks: taskReviews,
    counts: {
      hardFindings: hardFindingCount,
      missingTemplateEntries: outline.missing.length,
      extraTemplateEntries: outline.extra.length,
      templateDatabases: templateStructure.counts.database,
      pageDatabases: pageStructure.counts.database,
      templateCallouts: templateStructure.counts.callout,
      pageCallouts: pageStructure.counts.callout,
      templateColumns: templateStructure.counts.columns,
      pageColumns: pageStructure.counts.columns,
      relatedTasks: taskReviews.length,
      taskContextNotSet: taskReviews.filter((item) => {
        return item.reasonCodes.includes('PROJECT_TASK_CONTEXT_NOT_SET');
      }).length,
      taskNextActionNotSet: taskReviews.filter((item) => {
        return item.reasonCodes.includes('PROJECT_TASK_NEXT_ACTION_NOT_SET');
      }).length,
      taskAssigneeUnassigned: taskReviews.filter((item) => {
        return item.reasonCodes.includes('PROJECT_TASK_ASSIGNEE_UNASSIGNED_ALLOWED');
      }).length
    }
  };
}
