import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  createBoundedKmsClient: vi.fn(),
}));

vi.mock('../../src/encryption/kms-client.js', () => ({
  createBoundedKmsClient: fixtures.createBoundedKmsClient,
}));

import {
  createAwsConnectionEnvelopeEncryption,
  createAwsWebhookTriggerEnvelopeEncryption,
} from '../../src/server.js';

describe('AWS connection envelope runtime factory', () => {
  beforeEach(() => {
    fixtures.createBoundedKmsClient.mockReset();
  });

  it('validates config before construction and accepts only bounded fields', () => {
    for (const invalid of [
      {},
      { keyReference: '', region: 'eu-central-1' },
      { keyReference: 'alias/pertexo', region: '' },
      {
        keyReference: 'alias/pertexo',
        region: 'eu-central-1',
        endpoint: 'not-url',
      },
      {
        keyReference: 'alias/pertexo',
        region: 'eu-central-1',
        unexpected: true,
      },
      { keyReference: '€'.repeat(683), region: 'eu-central-1' },
    ]) {
      expect(() =>
        createAwsConnectionEnvelopeEncryption(invalid as never),
      ).toThrow();
    }
    expect(fixtures.createBoundedKmsClient).not.toHaveBeenCalled();
  });

  it('preflights webhook key-reference bytes before allocating a client', () => {
    expect(() =>
      createAwsWebhookTriggerEnvelopeEncryption({
        keyReference: '€'.repeat(683),
        region: 'eu-central-1',
      }),
    ).toThrow();
    expect(fixtures.createBoundedKmsClient).not.toHaveBeenCalled();

    const destroy = vi.fn();
    fixtures.createBoundedKmsClient.mockReturnValueOnce({
      send: vi.fn(),
      destroy,
    });
    const runtime = createAwsWebhookTriggerEnvelopeEncryption({
      keyReference: '€'.repeat(682),
      region: 'eu-central-1',
    });
    expect(fixtures.createBoundedKmsClient).toHaveBeenCalledOnce();
    runtime.close();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
