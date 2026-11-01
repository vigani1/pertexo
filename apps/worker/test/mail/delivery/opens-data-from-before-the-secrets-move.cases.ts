import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';

import {
  createApplicationSecretEnvelope,
  StoredKeyVerificationError,
  verifyStoredEncryptionKeys,
} from '@pertexo/integrations/server';
import {
  createEncryptionKeyRepository,
  createSystemMailDeliveryStore,
} from '@pertexo/secrets/server';

import { createSystemMailDeliveryHandler } from '../../../src/mail/delivery.js';
import {
  adminUrl,
  databaseUrl,
  storeConfig,
  workerBaseUrl,
} from './fixture.js';

/**
 * Sealed by the code at 8aa533c1c~1, before mail and encryption keys moved to
 * `secrets`, and pasted here. Don't regenerate: stored rows look like this.
 */
const RING = {
  current: { version: 'v1', key: Buffer.alloc(32, 7).toString('base64') },
};
const MAIL = {
  id: 'a5d1c1a0-6a0e-4c3b-9a55-0f0e6f4c1d21',
  expiresAt: '2099-01-01T00:00:00.000Z',
  ciphertext:
    '-pjbSpslS87ouU1Eaa1JOqRZHdHPh6PTNnXBYg2EAYTw_52p_hKw5-J4-FHq91alPWy-NJPEubr34atoromQ4EFHGXIstfUmbS3Qgu9d0Lp_MJKAUTYXw27E-gUTV-luEApuL5qDg82iQkNvzO6qilacdEqL2XZ8t2MRPyPf9zpHyaBjUVDiPw',
  nonce: 'rWpqoaRlVC2Ijs1k',
  tag: 'rp_JP8Xv336vAiFJt89vkg',
  keyVersion: 'v1',
};
const KEY_RECORD = {
  workspaceId: 'b2f0e4a8-3d55-4f6e-8c11-7a9d2e6b0c34',
  connectionId: 'c37a1e90-5b12-4d7c-9e44-1f2b3c4d5e6f',
  secretVersionId: 'd4e8b2c6-7f31-4a90-b5d2-6c7d8e9f0a1b',
  encryptedDataKey:
    'eyJjaXBoZXJ0ZXh0IjoiSnBzQWR6Y3pyak16YzFmLW1oMUVQNkdacVM0Z1lleW81WGtsV3RERnRNcDB2TU8zZ3YwcDZiTGJpUSIsIm5vbmNlIjoiRWwwTkZQSVJqaWN3OUJnUCIsInRhZyI6ImhHdnNXQmlpUHc4NUY4WnFiNEFLQkEiLCJrZXlWZXJzaW9uIjoidjEifQ',
};

const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

async function seedMail(owner: Pool, purpose: string): Promise<void> {
  await owner.query(
    `insert into app.system_mail_deliveries
      (id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,payload_key_version)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set
       purpose=excluded.purpose,status='queued',attempt_count=0,completed_at=null,
       payload_ciphertext=excluded.payload_ciphertext,payload_nonce=excluded.payload_nonce,
       payload_tag=excluded.payload_tag,payload_key_version=excluded.payload_key_version,
       lease_owner=null,lease_token=null,lease_expires_at=null,failure_code=null,
       provider_reference=null,next_attempt_at=clock_timestamp()`,
    [
      MAIL.id,
      purpose,
      MAIL.expiresAt,
      MAIL.ciphertext,
      MAIL.nonce,
      MAIL.tag,
      MAIL.keyVersion,
    ],
  );
}

async function deliver(sendNotification: ReturnType<typeof vi.fn>) {
  const worker = createSystemMailDeliveryStore(
    storeConfig(databaseUrl(workerBaseUrl)),
  );
  try {
    const handler = createSystemMailDeliveryHandler({
      store: worker,
      envelope: createApplicationSecretEnvelope(RING),
      email: {
        sendNotification,
        deduplicates: true,
      } as never,
      timeoutMillis: 5_000,
      workerId: 'mail:before-the-move',
    });
    await handler.runOnce().catch(() => 0);
  } finally {
    await worker.close();
  }
}

export function registerOpensDataFromBeforeTheSecretsMove(): void {
  it('delivers a mail sealed before the move and clears its ciphertext', async () => {
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const sendNotification = vi.fn().mockResolvedValue({
      kind: 'submitted',
      reference: 'provider-reference',
    });
    try {
      await seedMail(owner, 'password_reset');

      await deliver(sendNotification);

      expect(sendNotification).toHaveBeenCalledOnce();
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          fromEmail: 'security@example.test',
          toEmail: 'recipient@example.test',
          subject: 'Reset your password',
          text: 'Sealed before the move',
        }),
      );
      const row = await owner.query(
        'select status,payload_ciphertext from app.system_mail_deliveries where id=$1',
        [MAIL.id],
      );
      expect(row.rows).toEqual([
        { status: 'submitted', payload_ciphertext: null },
      ]);
    } finally {
      await owner.end();
    }
  });

  it('refuses to send one whose associated data has changed', async () => {
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const sendNotification = vi.fn();
    try {
      // The purpose is part of the sealed associated data.
      await seedMail(owner, 'verification');

      await deliver(sendNotification);

      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      await owner.query('delete from app.system_mail_deliveries where id=$1', [
        MAIL.id,
      ]);
      await owner.end();
    }
  });

  it('verifies an encryption key record from before the move, and refuses a changed one', async () => {
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const seed = async (workspaceId: string) => {
      const client = await owner.connect();
      try {
        await client.query('set session_replication_role=replica');
        await client.query('delete from app.connection_secret_versions');
        await client.query(
          `insert into app.connection_secret_versions
            (id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,
             ciphertext,nonce,auth_tag,created_by)
           values($1,$2,$3,'self-managed',$4,'Zg',repeat('A',16),repeat('A',22),$2)`,
          [
            KEY_RECORD.secretVersionId,
            workspaceId,
            KEY_RECORD.connectionId,
            KEY_RECORD.encryptedDataKey,
          ],
        );
        await client.query('set session_replication_role=origin');
      } finally {
        client.release();
      }
    };
    const verify = async (encryption: object = RING) => {
      const repository = createEncryptionKeyRepository({
        ...storeConfig(databaseUrl(maintenanceUrl)),
      });
      const signal = AbortSignal.timeout(10_000);
      try {
        return await verifyStoredEncryptionKeys(
          { mode: 'self-managed', encryption } as never,
          repository.read(signal),
          signal,
        );
      } finally {
        await repository.close();
      }
    };
    try {
      await seed(KEY_RECORD.workspaceId);
      await expect(verify()).resolves.toEqual({
        connectionKeys: 1,
        webhookKeys: 0,
      });

      // Rotating the master key keeps the old one readable as a previous key.
      await expect(
        verify({
          current: {
            version: 'v2',
            key: Buffer.alloc(32, 8).toString('base64'),
          },
          previous: [RING.current],
        }),
      ).resolves.toEqual({ connectionKeys: 1, webhookKeys: 0 });
      // Without it, the record no longer opens.
      await expect(
        verify({
          current: {
            version: 'v2',
            key: Buffer.alloc(32, 8).toString('base64'),
          },
        }),
      ).rejects.toBeInstanceOf(StoredKeyVerificationError);

      // The workspace is part of the key's associated data.
      await seed(KEY_RECORD.connectionId);
      await expect(verify()).rejects.toBeInstanceOf(StoredKeyVerificationError);
    } finally {
      await owner.query('delete from app.connection_secret_versions');
      await owner.end();
    }
  });
}
