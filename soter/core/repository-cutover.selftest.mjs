import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selftestRepositoryCutoverTransaction } from './repository-cutover.mjs';

export function selftestRepositoryCutover() {
  return selftestRepositoryCutoverTransaction();
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  selftestRepositoryCutover();
  process.stdout.write(
    'Repository cutover self-test passed: exact request bytes, checkpoint semantics, durable temp/directory recovery, rollback basis proof, monotonic time, path/link/mode rejection, and sanitized inspection.\n'
  );
}
