import { expect, it } from 'vitest';
import { describeProcessFailure } from '@pertexo/observability/server';
import { parseWorkerConfig } from '../../src/config/worker.js';
import { parseInvitationDeliveryConfig } from '../../src/config/invitation-delivery.js';
import { parseSystemMailDeliveryConfig } from '../../src/config/system-mail.js';
import {
  requiredEnvironment,
  callbackEnvironment,
} from './worker-environment.fixture.js';

const privateValue = 'relative-private-person@example.test';
const mail = {
  AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
  AUTH_MAIL_KEY_VERSION: 'v1',
  AUTH_MAIL_EMAIL_API_KEY: 'private-api-key',
};
const deployed = {
  ...requiredEnvironment,
  ...callbackEnvironment,
  ...mail,
  NODE_ENV: 'production',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test',
  CONNECTION_KMS_KEY_REFERENCE: 'alias/test',
  CONNECTION_KMS_REGION: 'eu-central-1',
  ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
  AUTH_MAIL_FROM: 'security@example.test',
};

it.each([
  {
    setting: 'ARTIFACT_SCRATCH_DIRECTORY',
    reason: 'absolute',
    run: () =>
      parseWorkerConfig({
        ...requiredEnvironment,
        ARTIFACT_SCRATCH_DIRECTORY: privateValue,
      }),
  },
  {
    setting: 'CODE_RUNNER_SOCKET',
    reason: 'absolute',
    run: () =>
      parseWorkerConfig({
        ...requiredEnvironment,
        CODE_RUNNER_SOCKET: privateValue,
      }),
  },
  {
    setting: 'ARTIFACT_STORE_ENDPOINT',
    reason: 'HTTPS',
    run: () =>
      parseWorkerConfig({
        ...deployed,
        ARTIFACT_STORE_ENDPOINT: 'http://private-endpoint.example.test',
      }),
  },
  {
    setting: 'PUBLIC_WEB_ORIGIN',
    reason: 'origin',
    run: () =>
      parseInvitationDeliveryConfig(
        {
          INVITATION_EMAIL_API_KEY: 'private-api-key',
          INVITATION_EMAIL_FROM: 'security@example.test',
          INVITATION_TOKEN_KEY: Buffer.alloc(32, 4).toString('base64'),
          INVITATION_TOKEN_KEY_VERSION: 'v1',
          PUBLIC_WEB_ORIGIN: `https://app.example.test/${privateValue}`,
        },
        { deployed: false },
      ),
  },
  {
    setting: 'PUBLIC_WEB_ORIGIN',
    reason: 'HTTPS',
    run: () =>
      parseInvitationDeliveryConfig(
        {
          INVITATION_EMAIL_API_KEY: 'private-api-key',
          INVITATION_EMAIL_FROM: 'security@example.test',
          INVITATION_TOKEN_KEY: Buffer.alloc(32, 4).toString('base64'),
          INVITATION_TOKEN_KEY_VERSION: 'v1',
          PUBLIC_WEB_ORIGIN: 'http://private-endpoint.example.test',
        },
        { deployed: true },
      ),
  },
  {
    setting: 'AUTH_MAIL_KEY',
    reason: 'required',
    run: () => parseSystemMailDeliveryConfig({}, { deployed: true }),
  },
  {
    setting: 'AUTH_MAIL_FROM',
    reason: 'required',
    run: () => parseSystemMailDeliveryConfig(mail, { deployed: true }),
  },
  {
    setting: 'PUBLIC_WEB_ORIGIN',
    reason: 'origin',
    run: () =>
      parseSystemMailDeliveryConfig(
        {
          ...mail,
          AUTH_MAIL_FROM: 'security@example.test',
          PUBLIC_WEB_ORIGIN: `https://app.example.test/${privateValue}`,
        },
        { deployed: false },
      ),
  },
])(
  'names $setting and its repair at the logging boundary',
  ({ setting, reason, run }) => {
    let failure: unknown;
    try {
      run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = describeProcessFailure(failure);
    expect(diagnostic).toContain(setting);
    expect(diagnostic).toContain(reason);
    for (const secret of [
      privateValue,
      'private-endpoint.example.test',
      'private-api-key',
    ])
      expect(diagnostic).not.toContain(secret);
  },
);
