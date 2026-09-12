import { describe, expect, it } from 'vitest';

import config from '../vitest.lifecycle-coverage.config.js';

describe('worker lifecycle coverage inventory', () => {
  it('measures the background shutdown and terminal-persistence owners', () => {
    expect(config.test?.coverage?.include).toEqual([
      'src/execution/{coordinator-runtime,failure-notification-handler,preview-attempt-handler,preview-maintenance-runtime}.ts',
      'src/runtime/background-task-deadline.ts',
    ]);
    expect(config.test?.coverage?.reportsDirectory).toBe(
      '../../coverage/worker-lifecycle',
    );
    expect(config.test?.coverage?.thresholds).toMatchObject({
      branches: 63,
      functions: 91,
      lines: 78,
      statements: 78,
      'src/runtime/background-task-deadline.ts': {
        branches: 100,
        functions: 83,
        lines: 81,
        statements: 81,
      },
    });
  });
});
