import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const MILESTONE_LINE = /^(?<indent>\t*)- \[(?<checked>[ x])\] (?:(?<progress>`in progress`)\s*)?(?:(?<health>`(?:at risk|off track)`)\s*)?\*\*(?<title>[^*\r\n]{1,200}?) - \*\*\*(?<description>[^*\r\n]{1,1000})\*$/;
const WORK_ITEM_LINE = /^(?<indent>\t+)- \[(?<checked>[ x])\] (?:(?:<mention-date start="(?<mentionDate>\d{4}-\d{2}-\d{2})"\/>|@(?<plainDate>\d{4}-\d{2}-\d{2})) - )?(?<owners>[^\r\n]{1,300}?) - (?<action>[^\r\n]{1,1000})$/;

function exactDate(value, label) {
  if (value === null) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value || '')
    ? new Date(value + 'T00:00:00.000Z')
    : null;
  if (!parsed
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(label + ' is not one exact calendar date.');
  }
  return value;
}

function exactDocument(document) {
  if (!document || typeof document !== 'object'
    || document.format !== 'markdown'
    || typeof document.uri !== 'string' || !document.uri
    || typeof document.title !== 'string' || !document.title
    || typeof document.body !== 'string' || !document.body
    || document.bodyFingerprint !== fingerprintJson(document.body)) {
    throw new Error('Project work parsing requires one exact fingerprint-bound Markdown document.');
  }
  return document;
}

function stableId(prefix, value) {
  return prefix + '.' + fingerprintJson(value).slice('sha256:'.length, 'sha256:'.length + 24);
}

function owners(value) {
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!parsed.length
    || parsed.some((item) => item.length > 100)
    || new Set(parsed.map((item) => item.toLocaleLowerCase('en'))).size !== parsed.length) {
    throw new Error('Project work-item owners must be exact, unique, and bounded.');
  }
  return parsed;
}

function progressState(match) {
  if (match.groups.checked === 'x') {
    if (match.groups.progress) {
      throw new Error('A completed project milestone cannot also carry an in-progress tag.');
    }
    return 'done';
  }
  return match.groups.progress ? 'in-progress' : 'todo';
}

function healthState(match) {
  return {
    '`at risk`': 'at-risk',
    '`off track`': 'off-track'
  }[match.groups.health] || 'on-track';
}

function workItemFromLine(line, index, milestone) {
  const match = line.match(WORK_ITEM_LINE);
  if (!match || match.groups.indent.length <= milestone.indent.length) return null;
  const date = exactDate(match.groups.mentionDate || match.groups.plainDate || null, 'Project work-item date');
  const ownerNames = owners(match.groups.owners);
  const action = match.groups.action.trim();
  if (!action || action.length > 1000) {
    throw new Error('Project work-item action must be exact bounded text.');
  }
  const lineFingerprint = fingerprintJson(line);
  return {
    id: stableId('work-item', {
      milestoneFingerprint: milestone.fingerprint,
      lineFingerprint
    }),
    sequence: index,
    milestoneId: milestone.id,
    milestoneFingerprint: milestone.fingerprint,
    checked: match.groups.checked === 'x',
    date,
    owners: ownerNames,
    action,
    oldLine: line,
    lineFingerprint,
    fingerprint: fingerprintJson({
      milestoneFingerprint: milestone.fingerprint,
      checked: match.groups.checked === 'x',
      date,
      owners: ownerNames,
      action,
      lineFingerprint
    })
  };
}

export function parseProjectWorkDocument(document, policy) {
  exactDocument(document);
  if (policy?.milestoneSyntaxVersion !== 'project-milestone-line/v1'
    || policy?.workItemSyntaxVersion !== 'dated-owner-action-line/v1') {
    throw new Error('Project work parsing requires the exact governed milestone and work-item grammar.');
  }
  const lines = document.body.replace(/\r\n?/g, '\n').split('\n');
  const milestones = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const milestoneMatch = line.match(MILESTONE_LINE);
    if (milestoneMatch) {
      const title = milestoneMatch.groups.title.trim();
      const description = milestoneMatch.groups.description.trim();
      if (!title || !description) {
        throw new Error('Project milestones require an outcome title and one-line description.');
      }
      const lineFingerprint = fingerprintJson(line);
      const fingerprint = fingerprintJson({
        title,
        description,
        lineFingerprint
      });
      current = {
        id: stableId('milestone', { title, lineFingerprint }),
        sequence: milestones.length,
        indent: milestoneMatch.groups.indent,
        title,
        description,
        progress: progressState(milestoneMatch),
        health: healthState(milestoneMatch),
        checked: milestoneMatch.groups.checked === 'x',
        oldLine: line,
        lineFingerprint,
        fingerprint,
        workItems: []
      };
      milestones.push(current);
      continue;
    }
    if (current) {
      const workItem = workItemFromLine(line, current.workItems.length, current);
      if (workItem) {
        current.workItems.push(workItem);
        continue;
      }
      if (/^\t+- \[[ x]\]/.test(line)) {
        throw new Error('Project work-item line does not satisfy the exact governed grammar.');
      }
      if (line.trim()) current = null;
    }
  }
  if (!milestones.length) {
    throw new Error('Project document contains no exact governed milestone lines.');
  }
  if (new Set(milestones.map((item) => item.title.toLocaleLowerCase('en'))).size !== milestones.length
    || new Set(milestones.map((item) => item.lineFingerprint)).size !== milestones.length) {
    throw new Error('Project milestone titles and exact source lines must be unique.');
  }
  const workItems = milestones.flatMap((milestone) => milestone.workItems);
  if (!workItems.length || milestones.some((milestone) => milestone.workItems.length === 0)) {
    throw new Error('Every project milestone requires at least one exact governed work item.');
  }
  if (new Set(workItems.map((item) => item.lineFingerprint)).size !== workItems.length) {
    throw new Error('Project work-item source lines must be unique.');
  }
  return {
    document: {
      uri: document.uri,
      title: document.title,
      bodyFingerprint: document.bodyFingerprint
    },
    milestones,
    workItems,
    fingerprint: fingerprintJson({
      documentFingerprint: document.bodyFingerprint,
      milestones: milestones.map((milestone) => ({
        fingerprint: milestone.fingerprint,
        workItemFingerprints: milestone.workItems.map((item) => item.fingerprint)
      }))
    })
  };
}

function healthTag(health) {
  return {
    'on-track': '',
    'at-risk': '`at risk`',
    'off-track': '`off track`'
  }[health];
}

export function renderProjectMilestoneLine(milestone, { progress, health }) {
  if (!['todo', 'in-progress', 'done'].includes(progress)
    || !['on-track', 'at-risk', 'off-track'].includes(health)) {
    throw new Error('Project milestone rendering requires exact progress and health states.');
  }
  const checked = progress === 'done' ? 'x' : ' ';
  const progressTag = progress === 'in-progress' ? '`in progress`' : '';
  const riskTag = healthTag(health);
  return milestone.indent + '- [' + checked + '] '
    + progressTag + riskTag
    + '**' + milestone.title + ' - ***' + milestone.description + '*';
}

export function renderCompletedProjectWorkItemLine(workItem) {
  if (!workItem || workItem.checked) {
    throw new Error('Only one current unchecked project work item can be completed in place.');
  }
  return workItem.oldLine.replace('- [ ] ', '- [x] ');
}
