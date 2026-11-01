import { authenticationMailAssociatedData } from '@pertexo/secrets/server';

import { createSystemMailEnqueueStore } from '@pertexo/secrets/server';

import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { DurableAuthenticationMail } from '../../../../src/authentication/mail/delivery.js';

import { adminUrl, databaseUrl, apiUrl } from '../fixture.js';

export function registerCommitsEncryptedAuthenticationMailBeforeAcknowledging(): void {
  it('commits encrypted authentication mail before acknowledging enqueue', async () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key },
    });
    const store = createSystemMailEnqueueStore({
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      ownerRole: 'pertexo_owner',
    });
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      const mailer = new DurableAuthenticationMail(
        store,
        envelope,
        'security@example.test',
      );
      await mailer.sendPasswordReset({
        recipient: 'secret-recipient@example.test',
        displayName: 'Ada',
        url: 'https://pertexo.test/reset-password?token=secret-link',
      });
      const stored = await owner.query<{
        id: string;
        purpose: string;
        expires_at: Date;
        payload_ciphertext: string;
        payload_nonce: string;
        payload_tag: string;
        payload_key_version: string;
      }>(
        `select id,purpose,expires_at,payload_ciphertext,payload_nonce,
                payload_tag,payload_key_version
           from app.system_mail_deliveries
          where purpose='password_reset'
          order by created_at desc limit 1`,
      );
      const row = stored.rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Durable mail row is missing');
      expect(JSON.stringify(row)).not.toContain(
        'secret-recipient@example.test',
      );
      expect(JSON.stringify(row)).not.toContain('secret-link');
      const rotated = createApplicationSecretEnvelope({
        current: {
          version: 'v2',
          key: Buffer.alloc(32, 10).toString('base64'),
        },
        previous: [{ version: 'v1', key }],
      });
      expect(
        rotated.open(
          {
            ciphertext: row.payload_ciphertext,
            nonce: row.payload_nonce,
            tag: row.payload_tag,
            keyVersion: row.payload_key_version,
          },
          authenticationMailAssociatedData(row.purpose, row.id, row.expires_at),
        ),
      ).toContain('secret-link');
    } finally {
      await Promise.all([store.close(), owner.end()]);
    }
  });
}
