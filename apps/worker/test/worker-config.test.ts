import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config/worker-config.js';

describe('parseWorkerConfig', () => {
  it('applies safe defaults when optional environment values are absent', () => {
    expect(parseWorkerConfig({})).toEqual({
      nodeEnv: 'development',
      logLevel: 'info',
    });
  });

  it('returns the typed worker settings for valid environment values', () => {
    const config = parseWorkerConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    });

    expect(config).toEqual({ nodeEnv: 'test', logLevel: 'debug' });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects an unsupported log level before the worker starts', () => {
    expect(() => parseWorkerConfig({ LOG_LEVEL: 'verbose' })).toThrow(
      /invalid worker configuration/i,
    );
  });
});
