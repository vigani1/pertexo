import { describe, expect, it } from 'vitest';

import { parseObservabilityConfig } from '../src/config.js';

describe('parseObservabilityConfig', () => {
  it('applies safe defaults and freezes the result', () => {
    const config = parseObservabilityConfig({
      serviceName: 'api',
      serviceVersion: '1.2.3',
    });

    expect(config).toEqual({
      environment: 'development',
      logLevel: 'info',
      otlpHeaders: {},
      serviceName: 'api',
      serviceVersion: '1.2.3',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.otlpHeaders)).toBe(true);
  });

  it.each([
    { serviceName: '', serviceVersion: '1' },
    { serviceName: 'api', serviceVersion: '' },
    {
      otlpHttpEndpoint: 'ftp://collector.example.test',
      serviceName: 'api',
      serviceVersion: '1',
    },
    {
      otlpHeaders: { authorization: 'secret' },
      serviceName: 'api',
      serviceVersion: '1',
    },
    { extra: true, serviceName: 'api', serviceVersion: '1' },
  ])('rejects invalid input %#', (input) => {
    expect(() => parseObservabilityConfig(input)).toThrow();
  });

  it('accepts and freezes explicit exporter configuration', () => {
    const config = parseObservabilityConfig({
      environment: 'production',
      logLevel: 'warn',
      otlpHeaders: { authorization: 'Bearer collector-token' },
      otlpHttpEndpoint: 'https://collector.example.test/otlp',
      serviceName: 'worker',
      serviceVersion: '2026.08.18',
    });

    expect(config.otlpHttpEndpoint).toBe('https://collector.example.test/otlp');
    expect(config.otlpHeaders).toEqual({
      authorization: 'Bearer collector-token',
    });
    expect(Object.isFrozen(config.otlpHeaders)).toBe(true);
  });
});
