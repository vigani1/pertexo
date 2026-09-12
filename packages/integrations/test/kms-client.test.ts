import { describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({
  clientConfigs: [] as unknown[],
  handlerConfigs: [] as unknown[],
}));

vi.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: class {
    public readonly kind = 'node-http-handler';

    public constructor(config: unknown) {
      recorded.handlerConfigs.push(config);
    }
  },
}));

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class {
    public readonly kind = 'kms-client';

    public constructor(config: unknown) {
      recorded.clientConfigs.push(config);
    }
  },
}));

import { createBoundedKmsClient } from '../src/credentials/kms-client.js';

describe('bounded KMS client', () => {
  it.each([
    ['without an endpoint', undefined],
    ['with an endpoint', 'http://kms.example.test'],
  ])('forwards bounded transport options %s', (_name, endpoint) => {
    recorded.clientConfigs.length = 0;
    recorded.handlerConfigs.length = 0;

    createBoundedKmsClient({ region: 'eu-central-1', endpoint });

    expect(recorded.handlerConfigs).toEqual([
      {
        connectionTimeout: 5_000,
        requestTimeout: 10_000,
        socketTimeout: 10_000,
        throwOnRequestTimeout: true,
      },
    ]);
    expect(recorded.clientConfigs).toEqual([
      expect.objectContaining({ region: 'eu-central-1', maxAttempts: 2 }),
    ]);
    const config = recorded.clientConfigs[0] as Record<string, unknown>;
    if (endpoint === undefined) expect(config).not.toHaveProperty('endpoint');
    else expect(config.endpoint).toBe(endpoint);
  });
});
