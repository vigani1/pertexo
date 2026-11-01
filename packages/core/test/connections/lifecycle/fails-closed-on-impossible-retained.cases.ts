import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  Pool,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerFailsClosedOnImpossibleRetained(): void {
  it('fails closed on impossible retained create and rotation claim states', async () => {
    const create = createInput();
    const existing = createInput();
    await connections.api.createConnection(existing);
    const rotateKey = `impossible-rotate-${existing.connectionId}`;
    const rotateHash = '6'.repeat(64);
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `insert into app.idempotency_records
           (id,workspace_id,operation,scope,key_hash,request_hash,status,
            resource_id,result_ref)
         values
           ($1,$2,'connection.create',$3,$4,$5,'in_progress',$6,'{}'::jsonb),
           ($7,$2,'connection.secret.rotate',$8,$9,$10,'failed',$11,'{}'::jsonb)`,
        [
          randomUUID(),
          workspaceA,
          ownerA,
          createHash('sha256').update(create.idempotencyKey).digest('hex'),
          create.requestHash,
          create.connectionId,
          randomUUID(),
          `${ownerA}:${existing.connectionId}`,
          createHash('sha256').update(rotateKey).digest('hex'),
          rotateHash,
          existing.connectionId,
        ],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }

    await expect(connections.api.createConnection(create)).rejects.toThrow(
      'Command claim is not resumable',
    );
    await expect(
      connections.api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: existing.connectionId,
        expectedCurrentSecretVersionId: existing.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(6),
        idempotencyKey: rotateKey,
        requestHash: rotateHash,
      }),
    ).rejects.toThrow('Command claim is not resumable');

    const verifier = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    try {
      await verifier.query('begin');
      await verifier.query('set local role pertexo_owner');
      await verifier.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      const rows = await verifier.query<{ count: string }>(
        `select count(*)::text as count from app.connections where id=$1`,
        [create.connectionId],
      );
      expect(rows.rows[0]?.count).toBe('0');
    } finally {
      await verifier.query('rollback').catch(() => undefined);
      await verifier.end();
    }
  });

  it('atomically creates one current immutable secret and replays an exact request', async () => {
    const input = createInput();
    const created = await connections.api.createConnection(input);
    const replayed = await connections.api.createConnection({
      ...input,
      connectionId: randomUUID(),
      secretVersionId: randomUUID(),
      sealed: sealed(2),
    });

    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      id: input.connectionId,
      workspaceId: workspaceA,
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
      currentSecretVersionId: input.secretVersionId,
    });
    expect(JSON.stringify(created)).not.toContain('encrypted');

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{
        connection_count: string;
        event_count: string;
        secret_count: string;
        plaintext_columns: string;
      }>(
        `select
           (select count(*)::text from app.connections where id = $1) as connection_count,
           (select count(*)::text from app.connection_secret_versions where connection_id = $1) as secret_count,
           (select count(*)::text from app.connection_events where connection_id = $1) as event_count,
           (select count(*)::text from information_schema.columns
             where table_schema = 'app'
               and table_name = 'connection_secret_versions'
               and column_name ~ '(plaintext|credential|secret_value)') as plaintext_columns`,
        [input.connectionId],
      );
      expect(result.rows[0]).toEqual({
        connection_count: '1',
        event_count: '1',
        secret_count: '1',
        plaintext_columns: '0',
      });
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }
  });
}
