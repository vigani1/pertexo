import { describe, expect, it } from 'vitest';

import config from '../vitest.coverage.config.js';

describe('@pertexo/node-catalog coverage inventory', () => {
  it('measures the server-only runtime guard with the server registry', () => {
    expect(config.test?.coverage?.include).toEqual([
      'src/{definition-resolution,registry,server}.ts',
      'src/server-only.ts',
    ]);
    expect(config.test?.coverage?.thresholds).toEqual({
      branches: 81,
      functions: 100,
      lines: 86,
      statements: 86,
    });
  });
});
