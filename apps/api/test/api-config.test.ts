import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../src/platform/config/api-config.js';

describe('parseApiConfig', () => {
  it('uses safe development defaults when optional values are absent', () => {
    const config = parseApiConfig({});

    expect(config).toEqual({
      host: '0.0.0.0',
      nodeEnv: 'development',
      port: 3000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses valid environment values into the typed public config', () => {
    const config = parseApiConfig({
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PORT: '4312',
    });

    expect(config).toEqual({
      host: '127.0.0.1',
      nodeEnv: 'test',
      port: 4312,
    });
  });

  it('accepts the staging deployment environment', () => {
    expect(parseApiConfig({ NODE_ENV: 'staging' }).nodeEnv).toBe('staging');
  });

  it('rejects a port outside the TCP port range', () => {
    expect(() => parseApiConfig({ PORT: '70000' })).toThrow();
  });
});
