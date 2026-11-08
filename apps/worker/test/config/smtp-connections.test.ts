import { expect, it } from 'vitest';
import { parseWorkerConfig } from '../../src/config/worker.js';
import { requiredEnvironment } from './worker-environment.fixture.js';

it('uses the operator SMTP permission and the same network list as HTTP', () => {
  expect(parseWorkerConfig(requiredEnvironment).smtpPolicy).toEqual({
    allowedPrivateNetworks: [],
    allowPlaintext: false,
  });
  const config = parseWorkerConfig({
    ...requiredEnvironment,
    SMTP_ALLOW_PLAINTEXT: 'true',
    HTTP_ALLOWED_PRIVATE_NETWORKS: '127.0.0.1/32',
  });
  expect(config.smtpPolicy?.allowPlaintext).toBe(true);
  expect(config.smtpPolicy?.allowedPrivateNetworks).toHaveLength(1);
  expect(config.smtpPolicy?.allowedPrivateNetworks).toEqual(
    config.httpRequest.allowedPrivateNetworks,
  );
  expect(() =>
    parseWorkerConfig({
      ...requiredEnvironment,
      SMTP_ALLOW_PLAINTEXT: 'sometimes',
    }),
  ).toThrow('Invalid worker configuration');
});
