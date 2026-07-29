import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { parseProjectWorkDocument } from '../../contexts/projects/project-work.mjs';

function inputError(message) {
  const error = new Error(message);
  error.code = 'PREPARATION_INPUT_INVALID';
  return error;
}

function exactDate(value, label) {
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    : null;
  const observed = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null;
  if (!match
    || Number.isNaN(observed.getTime())
    || observed.getUTCFullYear() !== Number(match[1])
    || observed.getUTCMonth() !== Number(match[2]) - 1
    || observed.getUTCDate() !== Number(match[3])) {
    throw inputError(label + ' must contain exact Gregorian dates in YYYY-MM-DD form.');
  }
  return value;
}

function exactList(input, id) {
  const value = input[id];
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 20
    || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw inputError('Project Capture requires exact non-empty ' + id + ' values.');
  }
  return value.map((item) => item.trim());
}

function milestoneIdentity(title) {
  return title.toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function milestoneInput(input) {
  const titles = exactList(input, 'milestoneTitles');
  const descriptions = exactList(input, 'milestoneDescriptions');
  const owners = exactList(input, 'milestoneOwners');
  const actions = exactList(input, 'milestoneActions');
  const dates = input.milestoneDates === undefined || input.milestoneDates === null
    ? []
    : input.milestoneDates;
  if (!Array.isArray(dates)
    || (dates.length !== 0 && dates.length !== titles.length)
    || descriptions.length !== titles.length
    || owners.length !== titles.length
    || actions.length !== titles.length) {
    throw inputError(
      'Project Capture milestone titles, descriptions, owners, actions, and supplied dates must have equal cardinality.'
    );
  }
  const milestoneIdentities = titles.map(milestoneIdentity);
  if (milestoneIdentities.some((identity) => !identity)
    || new Set(milestoneIdentities).size !== milestoneIdentities.length) {
    throw inputError(
      'Project Capture milestone titles must produce exact unique portable identities.'
    );
  }
  if (owners.some((owner) => owner.includes(',') || /[\r\n]/.test(owner))) {
    throw inputError(
      'Project Capture currently supports one exact owner token per milestone work item.'
    );
  }
  return titles.map((title, index) => ({
    title,
    description: descriptions[index],
    owners: owners[index],
    action: actions[index],
    date: dates.length ? exactDate(dates[index], 'Project milestone dates') : null
  }));
}

function exactProfile(creationProfile, input) {
  if (!creationProfile?.profile
    || creationProfile.profile.id !== input.creationProfile
    || creationProfile.fields?.profileId !== input.creationProfile
    || creationProfile.profile.bodyFormat !== 'portable-project-body/v1'
    || creationProfile.profile.milestoneSyntaxVersion !== 'project-milestone-line/v1'
    || creationProfile.profile.workItemSyntaxVersion !== 'dated-owner-action-line/v1'
    || creationProfile.definitionFingerprint !== fingerprintJson(creationProfile.profile)
    || creationProfile.record?.fields?.profileId !== input.creationProfile) {
    throw new Error('Project Capture requires one exact governed portable creation profile.');
  }
  return creationProfile;
}

function renderProjectBody(input, milestones, profile) {
  const milestoneLines = milestones.map((item) => {
    return '- [ ] **' + item.title + ' - ***' + item.description + '*';
  });
  const workItemLines = milestones.map((item) => {
    const date = item.date ? '@' + item.date + ' - ' : '';
    return '\t- [ ] ' + date + item.owners + ' - ' + item.action;
  });
  const bodyLines = [];
  for (let index = 0; index < milestones.length; index += 1) {
    bodyLines.push(milestoneLines[index], workItemLines[index]);
  }
  const body = '# ' + input.name
    + '\n\n## Overview\n\n' + input.overview
    + '\n\n## Milestones\n\n' + bodyLines.join('\n') + '\n';
  if (body.length > 20000) {
    throw inputError('Project Capture portable body exceeds the closed review and decision bound.');
  }
  const parsed = parseProjectWorkDocument({
    format: 'markdown',
    uri: 'soter-private://project-capture/candidate',
    title: input.name,
    body,
    bodyFingerprint: fingerprintJson(body)
  }, profile);
  if (parsed.milestones.length !== milestones.length
    || parsed.workItems.length !== milestones.length
    || parsed.milestones.some((item, index) => {
      const expected = milestones[index];
      const workItem = item.workItems[0];
      return item.title !== expected.title
        || item.description !== expected.description
        || workItem.date !== expected.date
        || workItem.owners.length !== 1
        || workItem.owners[0] !== expected.owners
        || workItem.action !== expected.action;
    })) {
    throw inputError(
      'Project Capture milestone values do not round-trip through the exact governed Project work grammar.'
    );
  }
  return {
    body,
    milestoneLines,
    workItemLines,
    bodyWorkFingerprint: parsed.fingerprint
  };
}

export function compileProjectCaptureValue({
  input,
  policy,
  schema,
  organization,
  creationProfile
}) {
  const organizationName = organization?.fields?.name;
  if (typeof organizationName !== 'string' || !organizationName.trim()) {
    throw new Error('Project Capture requires the exact resolved organization name.');
  }
  if (typeof input.organizationShortName !== 'string' || !input.organizationShortName.trim()) {
    throw inputError('Project Capture requires one exact private organization short name.');
  }
  const profile = exactProfile(creationProfile, input);
  const milestones = milestoneInput(input);
  let rendered;
  try {
    rendered = renderProjectBody(input, milestones, profile.profile);
  } catch (error) {
    if (error?.code === 'PREPARATION_INPUT_INVALID') throw error;
    throw inputError('Project Capture values do not satisfy the exact governed Project work grammar.');
  }
  const fields = {
    name: input.name,
    projectType: input.projectType,
    status: policy.defaultStatus,
    organizationUris: [organization.id],
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.targetEndDate ? { targetEndDate: input.targetEndDate } : {})
  };
  const issues = [];
  const expectedPrefix = input.organizationShortName.trim() + ': ';
  if (!input.name.startsWith(expectedPrefix) || input.name.length <= expectedPrefix.length) {
    issues.push({
      id: 'project-organization-short-name-mismatch',
      code: 'PROJECT_ORGANIZATION_SHORT_NAME_MISMATCH',
      claim: 'The candidate project name does not begin with the exact supplied organization short name followed by a colon and space.',
      basisIds: ['context.project-capture.policy', 'context.project-capture.organization']
    });
  }
  const typeField = schema.schema.fields.find((field) => field.id === 'projectType');
  if (!policy.allowedTypes.includes(input.projectType)
    || !typeField?.options?.includes(input.projectType)) {
    issues.push({
      id: 'project-type-unavailable',
      code: 'PROJECT_TYPE_UNAVAILABLE',
      claim: 'The selected project type is not present in both the governed policy and current provider schema.',
      basisIds: ['context.project-capture.policy', 'context.project-capture.schema']
    });
  }
  if (!profile.profile.allowedProjectTypes.includes(input.projectType)) {
    issues.push({
      id: 'project-creation-profile-type-mismatch',
      code: 'PROJECT_CREATION_PROFILE_TYPE_MISMATCH',
      claim: 'The selected project type is not allowed by the exact selected Project creation profile.',
      basisIds: ['context.project-capture.profile', 'context.project-capture.policy']
    });
  }
  if (input.startDate && input.targetEndDate && input.targetEndDate < input.startDate) {
    issues.push({
      id: 'project-date-order-conflict',
      code: 'PROJECT_DATE_ORDER_INVALID',
      claim: 'The target end date cannot precede the exact project start date.',
      basisIds: ['context.project-capture.policy']
    });
  }
  const profileBinding = {
    id: profile.profile.id,
    definitionFingerprint: profile.definitionFingerprint,
    externalRecordId: profile.record.id,
    externalRecordFingerprint: fingerprintJson(profile.record)
  };
  return {
    name: fields.name,
    organizationShortName: input.organizationShortName.trim(),
    creationProfile: profile.profile.id,
    creationProfileBinding: profileBinding,
    projectType: fields.projectType,
    status: fields.status,
    organizationUris: structuredClone(fields.organizationUris),
    startDate: fields.startDate || null,
    targetEndDate: fields.targetEndDate || null,
    body: rendered.body,
    milestoneLines: rendered.milestoneLines,
    workItemLines: rendered.workItemLines,
    bodyWorkFingerprint: rendered.bodyWorkFingerprint,
    fields,
    issues,
    afterFingerprint: fingerprintJson({
      recordType: 'project',
      creationProfile: profileBinding,
      fields,
      body: rendered.body
    })
  };
}
