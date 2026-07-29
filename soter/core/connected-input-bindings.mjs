import { fingerprintJson } from './lib/canonical-json.mjs';

const BINDING_KEYS = ['id', 'sourcePath', 'sourceStage', 'targetPath', 'transform'];
const SAFE_SEGMENT = /^[A-Za-z][A-Za-z0-9]*$/;
const PLACEHOLDER_PREFIX = 'soter-binding://write-output/';
const BINDING_TRANSFORMS = new Set(['exact-string', 'singleton-string-list']);

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && fingerprintJson(Object.keys(value).sort(compareText)) === fingerprintJson(expected));
}

function pathKey(value) {
  return value.join('.');
}

function readPath(value, parts) {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.hasOwn(current, part)) {
      throw new Error('Connected write-output binding source path is unavailable.');
    }
    current = current[part];
  }
  return current;
}

function writePath(value, parts, next) {
  let current = value;
  for (const part of parts.slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.hasOwn(current, part)
      || !current[part] || typeof current[part] !== 'object'
      || Array.isArray(current[part])) {
      throw new Error('Connected write-output binding target path is unavailable.');
    }
    current = current[part];
  }
  const final = parts.at(-1);
  if (!Object.hasOwn(current, final)) {
    throw new Error('Connected write-output binding target path is unavailable.');
  }
  current[final] = next;
}

export function writeOutputBindingPlaceholder(sourcePath, transform = 'exact-string') {
  if (!Array.isArray(sourcePath) || sourcePath.length < 1
    || sourcePath.some((part) => !SAFE_SEGMENT.test(part))) {
    throw new Error('Connected write-output binding source path is invalid.');
  }
  if (!BINDING_TRANSFORMS.has(transform)) {
    throw new Error('Connected write-output binding transform is invalid.');
  }
  const placeholder = PLACEHOLDER_PREFIX + sourcePath.join('/');
  return transform === 'singleton-string-list' ? [placeholder] : placeholder;
}

export function assertConnectedObservationInputBindings(observation) {
  if (!Object.hasOwn(observation, 'inputBindings')) return true;
  const bindings = observation.inputBindings;
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 5) {
    throw new Error('Connected observation input bindings require one through five entries.');
  }
  const ids = new Set();
  const targets = new Set();
  for (const binding of bindings) {
    if (!exactKeys(binding, BINDING_KEYS)
      || typeof binding.id !== 'string'
      || !/^binding\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(binding.id)
      || binding.sourceStage !== 'write'
      || !BINDING_TRANSFORMS.has(binding.transform)
      || !Array.isArray(binding.sourcePath) || binding.sourcePath.length < 1
      || binding.sourcePath.length > 8
      || binding.sourcePath.some((part) => !SAFE_SEGMENT.test(part))
      || !Array.isArray(binding.targetPath) || binding.targetPath.length < 1
      || binding.targetPath.length > 8
      || binding.targetPath.some((part) => !SAFE_SEGMENT.test(part))
      || ids.has(binding.id)
      || targets.has(pathKey(binding.targetPath))) {
      throw new Error('Connected observation input binding is invalid or ambiguous.');
    }
    ids.add(binding.id);
    targets.add(pathKey(binding.targetPath));
    const current = readPath(observation.input, binding.targetPath);
    if (fingerprintJson(current)
      !== fingerprintJson(writeOutputBindingPlaceholder(binding.sourcePath, binding.transform))) {
      throw new Error('Connected observation binding target does not carry its exact sealed placeholder.');
    }
  }
  return true;
}

export function connectedObservationInputFingerprint(observation) {
  assertConnectedObservationInputBindings(observation);
  return Object.hasOwn(observation, 'inputBindings')
    ? fingerprintJson({
        input: observation.input,
        inputBindings: observation.inputBindings
      })
    : fingerprintJson(observation.input);
}

export function resolveConnectedObservationInput(observation, writeOutput) {
  assertConnectedObservationInputBindings(observation);
  if (!Object.hasOwn(observation, 'inputBindings')) {
    return structuredClone(observation.input);
  }
  if (!writeOutput || typeof writeOutput !== 'object' || Array.isArray(writeOutput)) {
    throw new Error('Connected observation cannot resolve before exact write output exists.');
  }
  const input = structuredClone(observation.input);
  for (const binding of observation.inputBindings) {
    const value = readPath(writeOutput, binding.sourcePath);
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Connected write-output binding requires one exact non-empty string value.');
    }
    writePath(
      input,
      binding.targetPath,
      binding.transform === 'singleton-string-list' ? [value] : value
    );
  }
  return input;
}
