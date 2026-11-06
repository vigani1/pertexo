import { beforeEach, expect, it } from 'vitest';
import {
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  parseDatabaseConfig,
  randomUUID,
  workspaceId,
  Pool,
  migrationUrl,
} from './retention.support.js';
import {
  beforeEachFixture1,
  insertExpiredPendingUserUpload,
  readCapacity,
  withOwnerTransaction,
} from './retention-artifacts/fixture.js';

beforeEach(beforeEachFixture1);
const store = {
  delete: () => Promise.resolve(),
  head: () => Promise.resolve(null),
};
const coordinator = () =>
  createRunArtifactRetentionCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    store,
  );

it('reclaims only due reservations and keeps future pending and available files charged', async () => {
  const [due, future, available] = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of [due, future, available])
    await insertExpiredPendingUserUpload(id, 'a');
  await withOwnerTransaction((client) =>
    client.query(
      `update app.artifacts set expires_at=clock_timestamp()+interval '1 day',
         status=case when id=$3 then 'available' else 'pending' end,
         finalized_at=case when id=$3 then clock_timestamp() else null end
       where workspace_id=$1 and id=any($2::uuid[])`,
      [workspaceId, [future, available], available],
    ),
  );
  const retention = coordinator();
  try {
    expect(await retention.processNext()).toMatchObject({
      artifactId: due,
      status: 'completed',
    });
    expect(await retention.processNext()).toEqual({ status: 'idle' });
    expect(await readCapacity()).toEqual({ chargedCount: 2, chargedBytes: 20 });
    const rows = await withOwnerTransaction((client) =>
      client.query<{ id: string; status: string }>(
        'select id,status from app.artifacts where workspace_id=$1 order by id',
        [workspaceId],
      ),
    );
    expect(rows.rows).toEqual(
      [
        { id: future, status: 'pending' },
        { id: available, status: 'available' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
  } finally {
    await retention.close();
  }
});

it('reclaims unlocked due files while another transaction holds the oldest reservation', async () => {
  const locked = randomUUID();
  const other = randomUUID();
  await insertExpiredPendingUserUpload(locked, 'a');
  await insertExpiredPendingUserUpload(other, 'b');
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  const retention = coordinator();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query('select id from app.artifacts where id=$1 for update', [
      locked,
    ]);
    expect(await retention.processNext()).toMatchObject({
      artifactId: other,
      status: 'completed',
    });
    expect(await retention.processNext()).toEqual({ status: 'idle' });
    await client.query('commit');
    expect(await retention.processNext()).toMatchObject({
      artifactId: locked,
      status: 'completed',
    });
    expect(await readCapacity()).toEqual({ chargedCount: 0, chargedBytes: 0 });
  } finally {
    await client.query('rollback');
    client.release();
    await Promise.all([retention.close(), pool.end()]);
  }
});
