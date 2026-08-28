import { describe, expect, it } from 'vitest';

import { assertIntegrationGateConfigured } from './integration-gate.js';

describe('integration gate configuration', () => {
  it('allows an intentionally unrequested gate to remain skipped', () => {
    expect(() => {
      assertIntegrationGateConfigured({
        name: 'direct webhook HTTP integration',
        requested: false,
        required: { DATABASE_ADMIN_URL: undefined },
      });
    }).not.toThrow();
  });

  it('fails when a requested gate is missing required configuration', () => {
    expect(() => {
      assertIntegrationGateConfigured({
        name: 'direct webhook HTTP integration',
        requested: true,
        required: {
          DATABASE_ADMIN_URL: undefined,
          DATABASE_API_URL: 'postgresql://configured',
        },
      });
    }).toThrow(
      'Integration gate "direct webhook HTTP integration" was requested but is missing required configuration: DATABASE_ADMIN_URL',
    );
  });

  it('treats blank values as missing configuration', () => {
    expect(() => {
      assertIntegrationGateConfigured({
        name: 'direct webhook HTTP integration',
        requested: true,
        required: { DATABASE_ADMIN_URL: '  ' },
      });
    }).toThrow(/DATABASE_ADMIN_URL/u);
  });
});
