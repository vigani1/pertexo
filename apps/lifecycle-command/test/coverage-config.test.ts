import { describe, expect, it } from 'vitest';

import coverageConfig from '../vitest.coverage.config.js';

describe('lifecycle command coverage cohort', () => {
  it('keeps every audited executable source file in the selected inventory', () => {
    expect(coverageConfig.test?.coverage?.include).toEqual([
      'src/config.ts',
      'src/main.ts',
      'src/readiness-marker.ts',
      'src/run.ts',
    ]);
  });
});
