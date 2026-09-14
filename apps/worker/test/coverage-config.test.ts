import { describe, expect, it } from 'vitest';

import config from '../vitest.coverage.config.js';

describe('worker critical-runtime coverage configuration', () => {
  it('retains the base runner concurrency and source queue resolution', () => {
    expect(config.test?.environment).toBe('node');
    expect(config.test?.maxWorkers).toBe(4);
    expect(config.test?.exclude).toContain('**/*.integration.test.ts');
    expect(config.resolve?.alias).toHaveProperty('@pertexo/queue');
    expect(config.test?.coverage?.reportsDirectory).toBe(
      '../../coverage/worker',
    );
  });
});
