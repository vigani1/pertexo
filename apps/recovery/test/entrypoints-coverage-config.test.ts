import { describe, expect, it } from 'vitest';

import config from '../vitest.entrypoints-coverage.config.js';

describe('recovery entrypoint coverage cohort', () => {
  it('selects only the direct main suite and source', () => {
    expect(config.test?.include).toEqual(['test/main.test.ts']);
    expect(config.test?.coverage?.include).toEqual(['src/main.ts']);
    expect(config.test?.coverage?.reportsDirectory).toBe(
      '../../coverage/recovery-entrypoints',
    );
  });
});
