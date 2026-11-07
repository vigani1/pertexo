import { createSystemMailClient } from '../../src/mail/system-mail-client.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  prepareDeliveryIntegrationTestTsFixture,
  closeDeliveryIntegrationTestTsFixture,
  adminUrl,
  apiBaseUrl,
  workerBaseUrl,
  databaseUrl,
  storeConfig,
} from './system-mail-delivery.fixture.js';
import { randomUUID } from 'node:crypto';
import {
  createSystemMailEnqueueStore,
  createSystemMailDeliveryStore,
  createEncryptionKeyRepository,
} from '@pertexo/secrets/server';
import {
  createApplicationSecretEnvelope,
  StoredKeyVerificationError,
  verifyStoredEncryptionKeys,
} from '@pertexo/secrets/server';
import { openNoticeUnsubscribe } from '@pertexo/core/inbox';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { createSystemMailDeliveryHandler } from '@pertexo/secrets/server';
import {
  createNoticePreferencesStore,
  createNoticeMailStore,
  createWorkspaceInboxFoldStore,
} from '@pertexo/core/inbox';
import { createIdentityWorkspaceStore } from '@pertexo/core/tenant-access';
import { sealNoticeMail } from '../../src/mail/notice-content.js';

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

beforeAll(prepareDeliveryIntegrationTestTsFixture, 60_000);
afterAll(closeDeliveryIntegrationTestTsFixture, 30_000);
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
it('delivers real personal notice mail, refuses revoked content before DATA, and never repeats a possible SMTP delivery', async () => {
  const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
  const apiConfig = storeConfig(databaseUrl(apiBaseUrl));
  const maintenanceConfig = storeConfig(
    databaseUrl(
      process.env.DATABASE_MAINTENANCE_URL ??
        'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
    ),
  );
  const identity = createIdentityWorkspaceStore(apiConfig);
  const preferences = createNoticePreferencesStore(apiConfig, {
    emailAvailable: true,
  });
  const fold = createWorkspaceInboxFoldStore(apiConfig);
  const envelope = createApplicationSecretEnvelope({
    current: {
      version: 'notice-v1',
      key: Buffer.alloc(32, 17).toString('base64'),
    },
  });
  const notices = createNoticeMailStore(apiConfig, maintenanceConfig, (input) =>
    sealNoticeMail(
      envelope,
      'security@example.test',
      'https://app.example.test',
      input,
    ),
  );
  const deliveries = createSystemMailDeliveryStore(apiConfig);
  const messages: string[] = [];
  let acknowledge = true;
  let beforeConnect: () => Promise<void> = () => Promise.resolve();
  const relay = new SMTPServer({
    logger: false,
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onConnect: (_session, callback) => {
      void beforeConnect().then(
        () => {
          callback();
        },
        (error: unknown) => {
          callback(
            error instanceof Error ? error : new Error('Fixture refusal'),
          );
        },
      );
    },
    onData: (stream, _session, callback) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push(Buffer.concat(chunks).toString('utf8'));
        if (acknowledge) callback();
      });
    },
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('SMTP relay missing');
  const handler = createSystemMailDeliveryHandler({
    store: deliveries,
    envelope,
    email: createSystemMailClient({
      mode: 'smtp',
      host: '127.0.0.1',
      port: address.port,
      tls: 'none',
    }),
    notices,
    timeoutMillis: 5000,
    workerId: 'notices:smtp-proof',
  });
  const seed = async () => {
    const user = (
      await identity.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Notice reader',
      })
    ).id;
    const workspaceId = (
      await identity.createWorkspaceWithOwner({
        ownerUserId: user,
        name: 'SMTP notice proof',
        slug: `notice-${randomUUID().slice(0, 10)}`,
      })
    ).id;
    await owner.query('update app.users set email_verified=true where id=$1', [
      user,
    ]);
    const scope = { workspaceId, actorId: user };
    await preferences.replace({
      ...scope,
      mode: 'immediate',
      hour: 9,
      timeZone: 'UTC',
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const workflowId = randomUUID(),
      runId = randomUUID();
    await owner.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Only the safe workflow name',$3)",
      [workflowId, workspaceId, user],
    );
    await owner.query(
      `with tenant as(select set_config('app.workspace_id',$2::text,true)), revision as(insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) select $2::uuid,1,'{"PRIVATE":"NEVER_MAIL_VARIABLE"}'::jsonb from tenant returning workspace_id,revision) insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at,variable_set_revision) select $1::uuid,revision.workspace_id,$3::uuid,$4::uuid,'manual','failed','{"kind":"inline","value":{"private":"NEVER_MAIL_INPUT"}}'::jsonb,clock_timestamp()+interval '7 days',revision.revision from revision`,
      [runId, workspaceId, workflowId, randomUUID()],
    );
    await owner.query(
      "insert into app.workspace_inbox_events(id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at) values($1,$2,$3,$4,1,'failed',clock_timestamp())",
      [randomUUID(), workspaceId, workflowId, runId],
    );
    await fold.foldPending(100);
    return scope;
  };
  const batch = async (workspaceId: string) =>
    (
      await owner.query<{
        id: string;
        status: string;
        failure_code: string | null;
      }>(
        'select delivery.id,delivery.status,delivery.failure_code from app.system_mail_deliveries delivery join app.notice_mail_batches batch on batch.id=delivery.id where batch.workspace_id=$1 order by batch.created_at desc limit 1',
        [workspaceId],
      )
    ).rows[0];
  try {
    const first = await seed();
    await handler.runOnce();
    expect(await batch(first.workspaceId)).toMatchObject({
      status: 'submitted',
    });
    expect(messages).toHaveLength(1);
    const raw = messages[0] ?? '';
    const bodyStart = raw.indexOf('\r\n\r\n');
    const headers = raw.slice(0, bodyStart),
      encoded = raw.slice(bodyStart + 4);
    let body;
    if (/Content-Transfer-Encoding: base64/iu.test(headers)) {
      body = Buffer.from(encoded, 'base64').toString('utf8');
    } else if (/Content-Transfer-Encoding: quoted-printable/iu.test(headers)) {
      body = encoded
        .replace(/=\r?\n/gu, '')
        .replace(/=([A-F0-9]{2})/giu, (_match: string, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
    } else {
      body = encoded;
    }
    expect(body).toContain('Only the safe workflow name');
    expect(body).toContain(
      `https://app.example.test/w/${first.workspaceId}/inbox`,
    );
    expect(body).not.toContain('NEVER_MAIL');
    const token =
      /https:\/\/app\.example\.test\/notifications\/unsubscribe#([A-Za-z0-9_-]+)/u.exec(
        body,
      )?.[1];
    if (token === undefined)
      throw new Error('Notice unsubscribe capability missing');
    const claims = openNoticeUnsubscribe(envelope, token, new Date());
    expect(claims).toMatchObject({
      ...first,
      revision: 1,
      memberRevision: 1,
    });
    const unfoldedHeaders = headers.replace(/\r\n[ \t]+/gu, ' ');
    expect(unfoldedHeaders).toContain(
      `List-Unsubscribe: <https://app.example.test/v1/notifications/unsubscribe/one-click?token=${token}>`,
    );
    expect(unfoldedHeaders).toContain(
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    );
    const revoked = await seed();
    beforeConnect = async () => {
      await preferences.replace({
        ...revoked,
        mode: 'off',
        hour: 9,
        timeZone: 'UTC',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
    };
    await handler.runOnce();
    expect(await batch(revoked.workspaceId)).toMatchObject({
      status: 'failed',
      failure_code: 'notice.superseded',
    });
    expect(messages).toHaveLength(1);
    beforeConnect = () => Promise.resolve();
    acknowledge = false;
    const uncertain = await seed();
    await handler.runOnce();
    expect(await batch(uncertain.workspaceId)).toMatchObject({
      status: 'reconciliation_required',
      failure_code: 'delivery.network',
    });
    expect(messages).toHaveLength(2);
    await handler.runOnce();
    expect(messages).toHaveLength(2);
    acknowledge = true;
    const crashed = await seed();
    await notices.prepare();
    const [claim] = await deliveries.claim({
      workerId: 'notices:crashed',
      limit: 1,
    });
    if (claim === undefined) throw new Error('Missing crash claim');
    expect((await batch(crashed.workspaceId))?.id).toBe(claim.id);
    await owner.query(
      "update app.system_mail_deliveries set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [claim.id],
    );
    await handler.runOnce();
    expect(await batch(crashed.workspaceId)).toMatchObject({
      status: 'reconciliation_required',
      failure_code: 'delivery.recovered_unknown',
    });
    expect(messages).toHaveLength(2);
  } finally {
    await Promise.all([
      identity.close(),
      preferences.close(),
      fold.close(),
      notices.close(),
      deliveries.close(),
      owner.end(),
      new Promise<void>((resolve) => {
        relay.close(resolve);
      }),
    ]);
  }
}, 30000);
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
