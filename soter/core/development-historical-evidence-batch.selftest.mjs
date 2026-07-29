import { fileURLToPath } from 'node:url';

import {
  selftestDevelopmentHistoricalEvidenceBatchPublication
} from './development-historical-evidence-batch.mjs';

export function selftestDevelopmentHistoricalEvidenceBatch() {
  return selftestDevelopmentHistoricalEvidenceBatchPublication();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = selftestDevelopmentHistoricalEvidenceBatch();
  console.log(
    'Development historical evidence batch self-test passed: '
      + `${result.outputs} exact create-only outputs, crash recovery, rollback, no adoption, expiry, and sanitized inspection.`
  );
}
