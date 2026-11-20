import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  canonicalOutboxPayloadChecksum,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { HTTP_POLL_CONNECTION_SLOT } from '@pertexo/workflow-model';
import { Pool } from 'pg';
import { maintenanceConfig } from '../../../../../infrastructure/testing/worker-databases.mjs';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';
import { workflowTriggerProjection } from '../../../src/triggers/reconciliation/projection.js';
import { createScheduleTriggerScanner } from '../../../src/triggers/schedules/schedule-scanner.store.js';
import type { FetchPoll } from '../../../src/triggers/polling/items.js';

export function pollingFixture() {
  const fixture = createScheduleTriggerTestEnvironment();
  const { ownerQuery, workspaceId, workflowId } = fixture;
  const config = parseDatabaseConfig({
    connectionString: fixture.apiConnectionString,
  });
  const app = new Pool(config);
  let versionNumber = 1;
  const scanners: ReturnType<typeof createScheduleTriggerScanner>[] = [];

  async function publish(
    reconcileNow = true,
    url = 'https://feed.example.test/items',
    connectionId?: string,
  ) {
    const publishedVersionId = randomUUID();
    const triggerId = randomUUID();
    const outboxEventId = randomUUID();
    const graph = {
      nodes: [
        {
          id: 'poll',
          definition: { key: 'http.poll', version: 1 },
          ...(connectionId === undefined
            ? {}
            : {
                connectionRefs: { [HTTP_POLL_CONNECTION_SLOT]: connectionId },
              }),
          config: {
            url,
            intervalMinutes: 1,
            itemsPath: '$',
            itemKeyPath: '$.key',
          },
        },
      ],
      edges: [],
      settings: {},
    };
    const [desired] = workflowTriggerProjection(graph);
    if (desired === undefined) throw new Error('Missing polling projection');
    const payload = {
      workspaceId,
      workflowId,
      outboxEventId,
      publishedVersionId,
    };
    await withTenantScopedClient(app, { workspaceId }, async (client) => {
      await client.query(
        `insert into app.workflow_versions (id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
         values($1,$2,$3,$4,$5,$6,'{}',$7)`,
        [
          publishedVersionId,
          workspaceId,
          workflowId,
          ++versionNumber,
          graph,
          `wf:sha256:${'c'.repeat(64)}`,
          fixture.actorId,
        ],
      );
      await client.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, publishedVersionId],
      );
      await client.query(
        `insert into app.workflow_triggers (id, workspace_id, workflow_id, workflow_version_id, node_id, kind, desired_config, config_fingerprint)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          triggerId,
          workspaceId,
          workflowId,
          publishedVersionId,
          desired.nodeId,
          desired.kind,
          desired.config,
          desired.configFingerprint,
        ],
      );
      await client.query(
        `insert into app.outbox_events (id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
         values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4,$5)`,
        [
          outboxEventId,
          workspaceId,
          workflowId,
          payload,
          canonicalOutboxPayloadChecksum(payload),
        ],
      );
    });
    const reconcile = () => fixture.reconciliation.reconcile(payload);
    if (reconcileNow) await reconcile();
    return { triggerId, publishedVersionId, reconcile };
  }

  function scanner(fetchPoll: FetchPoll) {
    const instance = createScheduleTriggerScanner(
      maintenanceConfig(config),
      config,
      { fetchPoll },
    );
    scanners.push(instance);
    return (options: Partial<Parameters<typeof instance.scanDue>[0]> = {}) =>
      instance.scanDue({
        leaseOwner: randomUUID(),
        limit: 1,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory: fixture.checkpointFactory,
        ...options,
      });
  }

  async function read(triggerId: string) {
    const result = await ownerQuery<{
      hashes: string[] | null;
      retired: boolean;
      health: string;
      due: boolean;
      leased: boolean;
    }>(
      `select case when seen_keys is not null then
                array(select encode(entry,'hex') from unnest(seen_keys) as entry) end hashes,
              retired_at is not null retired, health_status health,
              next_poll_at<=statement_timestamp() due, lease_token is not null leased
         from app.trigger_polls join app.workflow_triggers on id=trigger_id where trigger_id=$1`,
      [triggerId],
    );
    return result.rows[0];
  }

  async function admitted() {
    const runs = await ownerQuery<{ item: unknown; outbox: number }>(
      `select run.input_ref->'value'->'item' item,
        (select count(*)::int from app.outbox_events where aggregate_id=run.id and job_name='advance-workflow-run') outbox
       from app.workflow_runs run where workflow_id=$1 and trigger_type='polling'
       order by admission_ticket`,
      [workflowId],
    );
    return runs.rows;
  }

  async function deliveries() {
    const result = await ownerQuery<{ n: number }>(
      "select count(*)::int n from app.outbox_events where job_name='advance-workflow-run'",
    );
    return result.rows[0]?.n;
  }

  return {
    deliveries,
    app,
    config,
    actorId: fixture.actorId,
    publish,
    scanner,
    read,
    admitted,
    ownerQuery,
    workspaceId,
    workflowId,
    initialize: fixture.initialize,
    checkpointFactory: fixture.checkpointFactory,
    makeDue: (triggerId: string) =>
      ownerQuery(
        'update app.trigger_polls set next_poll_at=statement_timestamp() where trigger_id=$1',
        [triggerId],
      ),
    async close() {
      await Promise.all([
        app.end(),
        ...scanners.map((resource) => resource.close()),
      ]);
      await fixture.close();
    },
  };
}
