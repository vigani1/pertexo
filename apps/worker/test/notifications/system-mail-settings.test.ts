import { expect, it } from 'vitest';
import { parseWorkerConfig } from '../../src/config/worker.js';
import { maintenanceDeliveries } from '../../src/transport/providers/maintenance.js';
import { workerEnvironment } from '../support/worker-environment.js';

it('enables failure delivery with server SMTP and no connection encryption or third-party account', () => {
  const config = parseWorkerConfig({
    ...workerEnvironment,
    WORKER_INSTANCE_ID: 'system-mail-proof',
    AUTH_MAIL_KEY: Buffer.alloc(32, 3).toString('base64'),
    AUTH_MAIL_KEY_VERSION: 'mail-v1',
    AUTH_MAIL_FROM: 'server@example.test',
    INVITATION_EMAIL_FROM: 'server@example.test',
    INVITATION_TOKEN_KEY: Buffer.alloc(32, 5).toString('base64'),
    INVITATION_TOKEN_KEY_VERSION: 'invitation-v1',
    SYSTEM_MAIL_TRANSPORT: 'smtp',
    SYSTEM_MAIL_SMTP_HOST: 'relay.example.test',
    SYSTEM_MAIL_SMTP_PORT: '587',
    SYSTEM_MAIL_SMTP_TLS: 'starttls',
  });
  expect(config.connectionEncryption).toBeUndefined();
  expect(maintenanceDeliveries(config).notification).toBe(true);
});
