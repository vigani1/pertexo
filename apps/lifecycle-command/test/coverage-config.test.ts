import { describe, expect, it } from 'vitest';

import coverageConfig, {
  LIFECYCLE_COMMAND_RISK_FILES,
} from '../vitest.coverage.config.js';

describe('lifecycle command coverage cohort', () => {
  it('keeps every audited executable source file in the selected inventory', () => {
    expect([...LIFECYCLE_COMMAND_RISK_FILES]).toEqual([
      'src/config.ts',
      'src/main.ts',
      'src/readiness-marker.ts',
      'src/run.ts',
    ]);
    expect(coverageConfig.test?.coverage?.include).toEqual([
      ...LIFECYCLE_COMMAND_RISK_FILES,
    ]);
  });
});
