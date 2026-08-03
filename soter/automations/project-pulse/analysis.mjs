import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import {
  parseProjectWorkDocument,
  renderProjectMilestoneLine
} from '../../contexts/projects/project-work.mjs';

function sorted(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function uniqueStrings(values, label, maximum = 100) {
  if (!Array.isArray(values)
    || values.length > maximum
    || values.some((value) => typeof value !== 'string' || !value)
    || new Set(values).size !== values.length) {
    throw new Error(label + ' must be exact, unique, and bounded.');
  }
  return sorted(values);
}

function exactRecord(record, type, label) {
  if (!record || record.type !== type
    || typeof record.id !== 'string' || !record.id
    || typeof record.version !== 'string'
    || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
    throw new Error(label + ' is not one exact normalized ' + type + ' record.');
  }
  return record;
}

function replaceExactlyOnce(body, oldText, newText, id) {
  const first = body.indexOf(oldText);
  const second = first < 0 ? -1 : body.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0 || oldText === newText) {
    throw new Error('Project milestone change ' + id + ' is not one exact changing replacement.');
  }
  return body.slice(0, first) + newText + body.slice(first + oldText.length);
}

function exactDate(value) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value || '')
    ? new Date(value + 'T00:00:00.000Z')
    : null;
  return Boolean(parsed
    && !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value);
}

function healthLabel(health) {
  return {
    'on-track': 'on track',
    'at-risk': 'at risk',
    'off-track': 'off track'
  }[health];
}

function lower(value) {
  return value.toLocaleLowerCase('en');
}

function promotedTaskIndex(tasks, workItems) {
  const workByAction = new Map();
  for (const item of workItems) {
    const key = lower(item.action);
    const current = workByAction.get(key) || [];
    current.push(item);
    workByAction.set(key, current);
  }
  const tasksByTitle = new Map();
  for (const task of tasks) {
    const key = lower(task.fields.title || '');
    const current = tasksByTitle.get(key) || [];
    current.push(task);
    tasksByTitle.set(key, current);
  }
  const ambiguousActions = [...workByAction.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key]) => key);
  const ambiguousTasks = [...tasksByTitle.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key]) => key);
  const assignments = workItems.map((workItem) => {
    const key = lower(workItem.action);
    const matches = ambiguousActions.includes(key) || ambiguousTasks.includes(key)
      ? []
      : tasksByTitle.get(key) || [];
    return {
      workItem,
      task: matches.length === 1 ? matches[0] : null
    };
  });
  const matchedTaskIds = new Set(assignments.flatMap((entry) => entry.task ? [entry.task.id] : []));
  return {
    assignments,
    ambiguousActions,
    ambiguousTasks,
    unmatchedTasks: tasks.filter((task) => !matchedTaskIds.has(task.id))
  };
}

function proposedProgress(milestone, assignments, policy) {
  const within = assignments.filter((entry) => entry.workItem.milestoneId === milestone.id);
  const completed = within.filter((entry) => {
    return entry.workItem.checked
      || Boolean(entry.task && policy.doneTaskStatuses.includes(lower(entry.task.fields.status)));
  }).length;
  const started = within.some((entry) => {
    if (entry.workItem.checked) return true;
    return Boolean(entry.task
      && !policy.notStartedTaskStatuses.includes(lower(entry.task.fields.status)));
  });
  const progress = within.length > 0 && completed === within.length
    ? 'done'
    : started ? 'in-progress' : 'todo';
  return { progress, completed, total: within.length };
}

function exactHealthMilestones(milestones, requested) {
  const selected = uniqueStrings(requested || [], 'Project health milestone titles', 20);
  const byTitle = new Map(milestones.map((milestone) => [lower(milestone.title), milestone]));
  const resolved = selected.map((title) => byTitle.get(lower(title)) || null);
  if (resolved.some((item) => !item)
    || new Set(resolved.map((item) => item.id)).size !== resolved.length) {
    throw new Error('Each project health milestone title must resolve exactly once.');
  }
  return new Set(resolved.map((item) => item.id));
}

export function analyzeProjectPulse({
  policy,
  project,
  tasks,
  document,
  statusDate,
  visibility,
  health,
  healthMilestones = []
}) {
  exactRecord(project, 'project', 'Project Pulse project');
  if (!Array.isArray(tasks)) throw new Error('Project Pulse tasks must be a bounded record list.');
  const taskUris = uniqueStrings(project.fields.taskUris || [], 'Project task identities');
  const normalizedTasks = tasks.map((task) => exactRecord(task, 'task', 'Project Pulse task'));
  const observedTaskIds = uniqueStrings(
    normalizedTasks.map((task) => task.id),
    'Project observed task identities'
  );
  if (fingerprintJson(taskUris) !== fingerprintJson(observedTaskIds)
    || normalizedTasks.some((task) => {
      const projects = task.fields.projectUris;
      return !Array.isArray(projects) || !projects.includes(project.id);
    })) {
    throw new Error('Project Pulse task records do not preserve the exact project relationship.');
  }
  if (document.uri !== project.id || document.title !== project.fields.name) {
    throw new Error('Project Pulse document does not preserve the exact project identity and title.');
  }
  const parsed = parseProjectWorkDocument(document, policy);
  const promoted = promotedTaskIndex(normalizedTasks, parsed.workItems);
  const selectedHealthMilestones = exactHealthMilestones(parsed.milestones, healthMilestones);
  const issues = [];
  if (promoted.ambiguousActions.length) {
    issues.push('PROJECT_WORK_ITEM_ACTION_AMBIGUOUS: Work-item actions must be unique before promoted tasks can be attributed to milestones.');
  }
  if (promoted.ambiguousTasks.length) {
    issues.push('PROJECT_PROMOTED_TASK_AMBIGUOUS: Multiple project tasks share one exact work-item action.');
  }
  const matchedAssignments = promoted.assignments.filter((entry) => entry.task);
  if (policy.progressRequiresPromotedTasks && matchedAssignments.length === 0) {
    issues.push('PROJECT_PROMOTED_TASKS_REQUIRED: A status write requires at least one exact work-item-to-task match.');
  }
  if (!exactDate(statusDate)) {
    issues.push('PROJECT_STATUS_DATE_INVALID: The project status date is not one exact calendar date.');
  }
  if (!policy.allowedVisibilities.includes(visibility)) {
    issues.push('PROJECT_STATUS_VISIBILITY_INVALID: The requested visibility is outside the governed policy vocabulary.');
  }
  if (!policy.allowedHealthStates.includes(health)) {
    issues.push('PROJECT_HEALTH_JUDGMENT_REQUIRED: Project health must be one explicit governed operator judgment.');
  }
  let afterBody = document.body;
  const milestoneChanges = parsed.milestones.map((milestone) => {
    const progress = proposedProgress(milestone, promoted.assignments, policy);
    const proposedHealth = selectedHealthMilestones.has(milestone.id) ? health : milestone.health;
    const blockedTasks = promoted.assignments.filter((entry) => {
      return entry.workItem.milestoneId === milestone.id
        && entry.task
        && policy.blockedTaskStatuses.includes(lower(entry.task.fields.status));
    });
    if (blockedTasks.length && proposedHealth === 'on-track') {
      issues.push('PROJECT_MILESTONE_HEALTH_CONTRADICTION: A milestone with exact blocked promoted work cannot remain on track.');
    }
    const newLine = renderProjectMilestoneLine(milestone, {
      progress: progress.progress,
      health: proposedHealth
    });
    const changed = newLine !== milestone.oldLine;
    if (changed) {
      afterBody = replaceExactlyOnce(afterBody, milestone.oldLine, newLine, milestone.id);
    }
    return {
      id: milestone.id,
      title: milestone.title,
      completed: progress.completed,
      total: progress.total,
      currentProgressTag: milestone.progress,
      proposedProgressTag: progress.progress,
      currentHealthTag: milestone.health,
      proposedHealthTag: proposedHealth,
      oldLine: milestone.oldLine,
      newLine,
      changed,
      workItemFingerprints: milestone.workItems.map((item) => item.fingerprint),
      promotedTaskIds: promoted.assignments.flatMap((entry) => {
        return entry.workItem.milestoneId === milestone.id && entry.task ? [entry.task.id] : [];
      })
    };
  });
  const resultingHealth = milestoneChanges.some((item) => item.proposedHealthTag === 'off-track')
    ? 'off-track'
    : milestoneChanges.some((item) => item.proposedHealthTag === 'at-risk')
      ? 'at-risk'
      : 'on-track';
  if (policy.healthMustBeOperatorJudgment && policy.allowedHealthStates.includes(health)
    && resultingHealth !== health) {
    issues.push('PROJECT_HEALTH_JUDGMENT_CONTRADICTED: The exact resulting milestone health does not support the operator judgment.');
  }
  const matchedTasks = matchedAssignments.map((entry) => entry.task);
  const doneTasks = matchedTasks.filter((task) => {
    return policy.doneTaskStatuses.includes(lower(task.fields.status));
  });
  const blockedTasks = matchedTasks.filter((task) => {
    return policy.blockedTaskStatuses.includes(lower(task.fields.status));
  });
  const completedWorkItems = milestoneChanges.reduce((total, milestone) => total + milestone.completed, 0);
  const totalWorkItems = milestoneChanges.reduce((total, milestone) => total + milestone.total, 0);
  const riskBasis = [
    ...blockedTasks.map((task) => 'blocked-task:' + task.id),
    ...milestoneChanges
      .filter((milestone) => milestone.proposedHealthTag !== 'on-track')
      .map((milestone) => milestone.proposedHealthTag + '-milestone:' + milestone.id)
  ];
  const summary = [
    'Promoted tasks: ' + doneTasks.length + '/' + matchedTasks.length
      + ' done; ' + blockedTasks.length + ' blocked.',
    'Milestones: ' + completedWorkItems + '/' + totalWorkItems
      + ' work items complete across ' + milestoneChanges.length + ' milestones.',
    'Unmatched project tasks: ' + promoted.unmatchedTasks.length + '; excluded from milestone progress.',
    'Health judgment: ' + (healthLabel(health) || 'unavailable') + '; observed basis: '
      + (riskBasis.length ? riskBasis.join(', ') : 'no blocked promoted task or risk-tagged milestone observed') + '.'
  ].join('\n');
  const headline = project.fields.name + ' — ' + statusDate + ' — ' + (healthLabel(health) || 'health unavailable');
  const status = {
    recordType: 'project-feed-entry',
    fields: {
      headline,
      category: policy.updateCategory,
      date: statusDate,
      summary,
      processed: policy.defaultProcessed,
      visibility,
      projectIds: [project.id]
    }
  };
  const updates = milestoneChanges.filter((change) => change.changed).map((change) => ({
    id: change.id,
    oldText: change.oldLine,
    newText: change.newLine,
    replaceAllMatches: false
  }));
  return {
    state: issues.length ? 'needs-input' : 'ready',
    issues: [...new Set(issues)],
    project: {
      id: project.id,
      name: project.fields.name,
      version: project.version,
      fingerprint: fingerprintJson(project)
    },
    tasks: {
      total: matchedTasks.length,
      done: doneTasks.length,
      blocked: blockedTasks.length,
      unmatched: promoted.unmatchedTasks.length,
      completionPercent: matchedTasks.length
        ? Math.round((doneTasks.length / matchedTasks.length) * 100)
        : null,
      records: matchedAssignments.map((entry) => ({
        id: entry.task.id,
        title: entry.task.fields.title,
        status: entry.task.fields.status,
        milestoneId: entry.workItem.milestoneId,
        workItemFingerprint: entry.workItem.fingerprint,
        fingerprint: fingerprintJson(entry.task)
      }))
    },
    milestones: milestoneChanges,
    health: {
      state: policy.allowedHealthStates.includes(health) ? health : 'unavailable',
      requested: health,
      contradicted: issues.some((issue) => issue.startsWith('PROJECT_HEALTH_')
        || issue.startsWith('PROJECT_MILESTONE_HEALTH_')),
      basis: riskBasis
    },
    status: {
      ...status,
      afterFingerprint: fingerprintJson(status)
    },
    document: {
      uri: document.uri,
      title: document.title,
      expectedBodyFingerprint: document.bodyFingerprint,
      afterBodyFingerprint: fingerprintJson(afterBody),
      updates,
      changed: updates.length > 0
    },
    limitations: [
      'Milestone progress uses exact work-item-to-task title inheritance within one project; unmatched project tasks and unchecked unpromoted work items are never presented as promoted task completion.',
      'Health is a required operator judgment. Automation only checks exact contradictions and applies explicitly selected milestone tags.',
      'A milestone completion checkbox remains part of the separately confirmed exact document batch; task completion alone never writes it during preparation.',
      'This deterministic analysis creates no approval, continuation, provider call, write, proof, or maturity authority.'
    ]
  };
}
