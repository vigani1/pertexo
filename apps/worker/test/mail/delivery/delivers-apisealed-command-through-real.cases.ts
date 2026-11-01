import { randomUUID } from 'node:crypto';
import { createSystemMailEnqueueStore } from '@pertexo/secrets/server';
import { createSystemMailDeliveryStore } from '@pertexo/secrets/server';

import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { expect, it, vi } from 'vitest';
import { createSystemMailDeliveryHandler } from '../../../src/mail/delivery.js';
import {
  adminUrl,
  apiBaseUrl,
  workerBaseUrl,
  databaseUrl,
  storeConfig,
} from './fixture.js';

export function registerDeliversAPISealedCommandThroughReal(): void {
  it('delivers an API-sealed command through the real worker role and clears ciphertext', async () => {
    const api = createSystemMailEnqueueStore(
      storeConfig(databaseUrl(apiBaseUrl)),
    );
    const worker = createSystemMailDeliveryStore(
      storeConfig(databaseUrl(workerBaseUrl)),
    );
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 6).toString('base64') },
    });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const sendNotification = vi.fn().mockResolvedValue({
      kind: 'submitted',
      reference: 'fake-provider-reference',
    });
    try {
      await api.enqueue({
        id,
        purpose: 'password_reset',
        expiresAt,
        sealedPayload: envelope.seal(
          JSON.stringify({
            fromEmail: 'security@example.test',
            toEmail: 'recipient@example.test',
            subject: 'Reset your password',
            text: 'Immutable local test message',
          }),
          `pertexo/authentication-mail/password_reset/${id}/${expiresAt.toISOString()}`,
        ),
      });
      const before = await owner.query<{ payload_ciphertext: string | null }>(
        `select payload_ciphertext from app.system_mail_deliveries where id=$1`,
        [id],
      );
      expect(before.rows[0]?.payload_ciphertext).not.toContain(
        'recipient@example.test',
      );

      const handler = createSystemMailDeliveryHandler({
        store: worker,
        envelope,
        email: { sendNotification, deduplicates: true },

        timeoutMillis: 5_000,
        workerId: 'auth-mail:integration',
      });
      await expect(handler.runOnce()).resolves.toBe(1);
      expect(sendNotification).toHaveBeenCalledOnce();
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          toEmail: 'recipient@example.test',
          text: 'Immutable local test message',
          idempotencyKey: `authentication-mail:${id}`,
        }),
      );
      const after = await owner.query<{
        status: string;
        payload_ciphertext: string | null;
        provider_reference: string | null;
      }>(
        `select status,payload_ciphertext,provider_reference from app.system_mail_deliveries where id=$1`,
        [id],
      );
      expect(after.rows[0]).toEqual({
        status: 'submitted',
        payload_ciphertext: null,
        provider_reference: 'fake-provider-reference',
      });
      await expect(handler.runOnce()).resolves.toBe(0);
      expect(sendNotification).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([api.close(), worker.close(), owner.end()]);
    }
  }, 30_000);

  it('delivers a sealed account command through a real SMTP session and fences lost acknowledgements', async () => {
    const messages: string[] = [];
    let acknowledge = true;
    const relay = new SMTPServer({
      logger: false,
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData: (stream, _session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          messages.push(Buffer.concat(chunks).toString());
          if (acknowledge) callback();
        });
      },
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing SMTP fixture');
    const api = createSystemMailEnqueueStore(
      storeConfig(databaseUrl(apiBaseUrl)),
    );
    const worker = createSystemMailDeliveryStore(
      storeConfig(databaseUrl(workerBaseUrl)),
    );
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 6).toString('base64') },
    });
    const client = createSystemMailClient({
      mode: 'smtp',
      host: '127.0.0.1',
      port: address.port,
      tls: 'none',
    });
    const handler = createSystemMailDeliveryHandler({
      store: worker,
      envelope,
      email: client,
      timeoutMillis: 500,
      workerId: 'smtp:integration',
    });
    const enqueue = async () => {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 60000);
      await api.enqueue({
        id,
        purpose: 'verification',
        expiresAt,
        sealedPayload: envelope.seal(
          JSON.stringify({
            fromEmail: 'security@example.test',
            toEmail: 'recipient@example.test',
            subject: 'Account verification',
            text: 'Immutable verification link',
          }),
          `pertexo/authentication-mail/verification/${id}/${expiresAt.toISOString()}`,
        ),
      });
      return id;
    };
    try {
      const first = await enqueue();
      await handler.runOnce();
      expect(
        (
          await owner.query(
            'select status from app.system_mail_deliveries where id=$1',
            [first],
          )
        ).rows[0],
      ).toEqual({ status: 'submitted' });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Immutable verification link');
      acknowledge = false;
      const uncertain = await enqueue();
      await handler.runOnce();
      expect(
        (
          await owner.query(
            'select status from app.system_mail_deliveries where id=$1',
            [uncertain],
          )
        ).rows[0],
      ).toEqual({ status: 'reconciliation_required' });
      await handler.runOnce();
      expect(messages).toHaveLength(2);
      const crashed = await enqueue();
      await worker.claim({ workerId: 'smtp:crashed', limit: 1 });
      await owner.query(
        "update app.system_mail_deliveries set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [crashed],
      );
      await handler.runOnce();
      expect(messages).toHaveLength(2);
      expect(
        (
          await owner.query(
            'select status from app.system_mail_deliveries where id=$1',
            [crashed],
          )
        ).rows[0],
      ).toEqual({ status: 'reconciliation_required' });
    } finally {
      await Promise.all([
        api.close(),
        worker.close(),
        owner.end(),
        new Promise<void>((resolve) => {
          relay.close(resolve);
        }),
      ]);
    }
  }, 30000);
}
