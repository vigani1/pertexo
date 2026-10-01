import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config/worker-config.js';
import { parseConnectionRunHealthMode } from '../src/config/connection-run-health-config.js';

const environment = {
  DATABASE_WORKER_URL: 'postgresql://worker:secret@localhost:5432/pertexo',
  DATABASE_DISPATCHER_URL:
    'postgresql://dispatcher:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('connection run health mode', () => {
  it('defaults off in the actual worker config', () => {
    expect(parseWorkerConfig(environment).connectionRunHealthMode).toBe('off');
  });
  it.each(['off', 'observe', 'enforce'] as const)(
    'accepts explicit %s without activation side effects',
    (mode) => {
      expect(
        parseWorkerConfig({ ...environment, CONNECTION_RUN_HEALTH_MODE: mode })
          .connectionRunHealthMode,
      ).toBe(mode);
    },
  );
  it.each(['true', '', 'ENFORCE', 'enforce ', null, 1])(
    'rejects invalid mode %#',
    (mode) => {
      expect(() => parseConnectionRunHealthMode(mode)).toThrow();
      expect(() =>
        parseWorkerConfig({ ...environment, CONNECTION_RUN_HEALTH_MODE: mode }),
      ).toThrow('Invalid worker configuration');
    },
  );
});
