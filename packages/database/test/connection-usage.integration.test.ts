import { describe, expect, it } from 'vitest';
import {
  CONNECTION_USAGE_PAGE_SQL,
  createConnectionUsagePersistence,
} from '../src/connections/usage.queries.js';
import {
  Pool,
  apiBaseUrl,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  ownerB,
  randomUUID,
  registerCurrentConnectionsFixture,
  workspaceA,
  workspaceB,
  ConnectionNotFoundError,
  createHash,
} from './support/connections.integration.support.js';

const connections = registerCurrentConnectionsFixture();

describe('authorized published connection usage', () => {
  it('rechecks source-bound active membership', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const apiPool = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    const ownerPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    try {
      const usage = createConnectionUsagePersistence(apiPool);
      const owner = await ownerPool.connect();
      try {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceA,
        ]);
        await owner.query(
          "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
          [workspaceA, ownerA],
        );
        await owner.query('commit');
        await expect(
          usage.listConnectionUsage({
            workspaceId: workspaceA,
            actorId: ownerA,
            connectionId: input.connectionId,
          }),
        ).rejects.toThrow(ConnectionNotFoundError);
      } finally {
        await owner.query('rollback');
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceA,
        ]);
        await owner.query(
          "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
          [workspaceA, ownerA],
        );
        await owner.query('commit');
        owner.release();
      }
    } finally {
      await apiPool.end();
      await ownerPool.end();
    }
  });
  it('pages retained immutable versions with sorted deduplicated operations and current/archive labels through the projection index', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const versionIds = Array.from({ length: 3 }, () => randomUUID()).sort();
    const workflowId = randomUUID();
    const ownerPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const apiPool = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    try {
      const owner = await ownerPool.connect();
      try {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceA,
        ]);
        await owner.query(
          `insert into app.workflows (id,workspace_id,name,created_by,lifecycle_status)
          values ($1,$2,'Archived usage workflow',$3,'archived')`,
          [workflowId, workspaceA, ownerA],
        );
        for (const [index, versionId] of versionIds.entries()) {
          await owner.query(
            `insert into app.workflow_versions
            (id,workspace_id,workflow_id,version_number,schema_version,graph_json,checksum,executable_json,published_by)
            values ($1,$2,$3,$4,1,'{}'::jsonb,$5,'{}'::jsonb,$6)`,
            [
              versionId,
              workspaceA,
              workflowId,
              index + 1,
              `wf:v2:sha256:${createHash('sha256').update(versionId).digest('hex')}`,
              ownerA,
            ],
          );
          await owner.query(
            `insert into app.workflow_integration_usage
            (workspace_id,workflow_version_id,provider_key,operation_key,connection_id) values
            ($1,$2,'http','upload',$3), ($1,$2,'http','request',$3), ($1,$2,'slack','request',$3)`,
            [workspaceA, versionId, input.connectionId],
          );
        }
        await owner.query(
          'update app.workflows set published_version_id = $1 where id = $2',
          [versionIds[2], workflowId],
        );
        // A retained draft-only workflow deliberately has no projection row.
        await owner.query(
          `insert into app.workflows (id,workspace_id,name,created_by)
          values ($1,$2,'Draft-only',$3)`,
          [randomUUID(), workspaceA, ownerA],
        );
        await owner.query('commit');
      } finally {
        await owner.query('rollback');
        owner.release();
      }
      const usage = createConnectionUsagePersistence(apiPool);
      const observed = [];
      let after: { workflowVersionId: string } | undefined;
      do {
        const page = await usage.listConnectionUsage({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          limit: 1,
          ...(after === undefined ? {} : { after }),
        });
        expect(page.items).toHaveLength(1);
        observed.push(...page.items);
        after = page.nextCursor;
      } while (after !== undefined);
      expect(observed.map((row) => row.workflowVersionId)).toEqual(versionIds);
      expect(observed.map((row) => row.isCurrentPublication)).toEqual([
        false,
        false,
        true,
      ]);
      expect(
        observed.every((row) => row.workflowLifecycleStatus === 'archived'),
      ).toBe(true);
      expect(
        observed.every(
          (row) => JSON.stringify(row.operationKeys) === '["request","upload"]',
        ),
      ).toBe(true);
      expect(JSON.stringify(observed)).not.toMatch(
        /secret|credential|graph_json/iu,
      );
      await expect(
        usage.listConnectionUsage({
          workspaceId: workspaceB,
          actorId: ownerB,
          connectionId: input.connectionId,
        }),
      ).rejects.toThrow(ConnectionNotFoundError);
      await expect(
        usage.listConnectionUsage({
          workspaceId: workspaceA,
          actorId: ownerB,
          connectionId: input.connectionId,
        }),
      ).rejects.toThrow(ConnectionNotFoundError);
      await expect(
        usage.listConnectionUsage({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          after: { workflowVersionId: randomUUID() },
        }),
      ).rejects.toThrow(ConnectionNotFoundError);
      expect(() =>
        usage.listConnectionUsage({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          limit: 101,
        }),
      ).toThrow();
      const client = await apiPool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceA,
        ]);
        await client.query('set local enable_seqscan = off');
        const plan = await client.query(
          `explain (format json) ${CONNECTION_USAGE_PAGE_SQL}`,
          [workspaceA, input.connectionId, versionIds[0], 2],
        );
        const serialized = JSON.stringify(plan.rows);
        expect(serialized).toContain(
          'workflow_integration_usage_connection_idx',
        );
        expect(serialized).toContain('Limit');
        expect(serialized).not.toContain('Seq Scan');
      } finally {
        await client.query('rollback');
        client.release();
      }
    } finally {
      await apiPool.end();
      await ownerPool.end();
    }
  });
});
