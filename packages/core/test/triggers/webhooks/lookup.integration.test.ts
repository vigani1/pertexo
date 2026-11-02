import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  actorId,
  afterAllFixture2,
  apiQuery,
  beforeAllFixture1,
  createWebhookScenario,
  hash,
  ownerQuery,
  readinessPool,
  secret,
  webhook,
  workspaceId,
} from './fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

type Scenario = Awaited<ReturnType<typeof createWebhookScenario>>;

/** The door itself, as the application role calls it with no workspace in scope. */
async function lookup(endpointKeyHash: string) {
  const { rows } = await readinessPool.query<{
    endpoint_id: string;
    workspace_id: string;
    endpoint_status: string;
    workflow_lifecycle_status: string;
    workspace_status: string;
    previous_secret_version_id: string | null;
  }>('select * from app.resolve_public_webhook_endpoint($1)', [
    endpointKeyHash,
  ]);
  return rows;
}

const CLOSED = [
  {
    name: 'a disabled endpoint',
    close: ({ verification }: Scenario) =>
      apiQuery(
        "update app.webhook_trigger_endpoints set status='disabled' where id=$1",
        [verification.endpointId],
      ),
    reports: { endpoint_status: 'disabled' },
  },
  {
    name: 'an archived workflow',
    close: ({ verification }: Scenario) =>
      ownerQuery(
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [verification.workflowId],
      ),
    reports: { workflow_lifecycle_status: 'archived' },
  },
  {
    name: 'a suspended workspace',
    close: () =>
      ownerQuery("update app.workspaces set status='suspended' where id=$1", [
        workspaceId,
      ]),
    reports: { workspace_status: 'suspended' },
    workspaceClosed: true,
  },
  {
    name: 'a workspace pending deletion',
    close: () =>
      ownerQuery(
        `update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),
           deletion_requested_by=$2,deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
        [workspaceId, actorId],
      ),
    reports: { workspace_status: 'pending_deletion' },
    workspaceClosed: true,
  },
];

describe('the public address lookup', () => {
  it.each(CLOSED)(
    'reports $name to core, and core reads it as an unknown address',
    async ({ close, reports, workspaceClosed }) => {
      const scenario = await createWebhookScenario();
      const { endpointKeyHash } = scenario.verification;
      try {
        await close(scenario);
        expect(await lookup(endpointKeyHash)).toMatchObject([reports]);
        await expect(
          webhook.resolveVerification(endpointKeyHash),
        ).resolves.toBeNull();
      } finally {
        if (workspaceClosed === true)
          await ownerQuery(
            `update app.workspaces set status='active',deletion_requested_at=null,
               deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
            [workspaceId],
          );
      }
    },
  );

  it('still reports nothing when the published version has no such step', async () => {
    const scenario = await createWebhookScenario();
    const { verification } = scenario;
    const versionId = randomUUID();
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,50,$4::jsonb,$5,'{}'::jsonb,$6)`,
      [
        versionId,
        workspaceId,
        verification.workflowId,
        JSON.stringify({ settings: {}, nodes: [], edges: [] }),
        `wf:sha256:${hash(versionId)}`,
        actorId,
      ],
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [verification.workflowId, versionId],
    );
    expect(await lookup(verification.endpointKeyHash)).toEqual([]);
    await expect(
      webhook.resolveVerification(verification.endpointKeyHash),
    ).resolves.toBeNull();
  });

  it('answers only for its one address and leaves no workspace in scope', async () => {
    const one = await createWebhookScenario();
    const other = await createWebhookScenario();
    expect(await lookup(one.verification.endpointKeyHash)).toMatchObject([
      { endpoint_id: one.verification.endpointId, workspace_id: workspaceId },
    ]);
    expect(await lookup(other.verification.endpointKeyHash)).toMatchObject([
      { endpoint_id: other.verification.endpointId },
    ]);
    expect(await lookup(hash(randomUUID()))).toEqual([]);

    const client = await readinessPool.connect();
    try {
      await client.query('begin');
      await client.query(
        'select * from app.resolve_public_webhook_endpoint($1)',
        [one.verification.endpointKeyHash],
      );
      const { rows } = await client.query<{ scope: string | null }>(
        "select current_setting('app.workspace_id',true) scope",
      );
      expect(rows[0]?.scope ?? '').toBe('');
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('hands out the previous secret inside its window and not outside', async () => {
    const { verification, resources, published } =
      await createWebhookScenario();
    const nextSecret = secret();
    await webhook.rotateSecret({
      workspaceId,
      actorId,
      workflowId: published.created.workflowId,
      triggerId: resources.webhookId,
      endpointKeyHash: verification.endpointKeyHash,
      secret: nextSecret,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    });
    const inside = await webhook.resolveVerification(
      verification.endpointKeyHash,
    );
    expect(inside?.currentSecret.id).toBe(nextSecret.id);
    expect(inside?.previousSecret?.id).toBe(verification.currentSecret.id);

    await apiQuery(
      `update app.webhook_trigger_endpoints
          set previous_secret_valid_until=clock_timestamp()-interval '1 millisecond'
        where id=$1`,
      [verification.endpointId],
    );
    expect(await lookup(verification.endpointKeyHash)).toMatchObject([
      { previous_secret_version_id: null },
    ]);
    const outside = await webhook.resolveVerification(
      verification.endpointKeyHash,
    );
    expect(outside?.currentSecret.id).toBe(nextSecret.id);
    expect(outside?.previousSecret).toBeUndefined();
  });
});
