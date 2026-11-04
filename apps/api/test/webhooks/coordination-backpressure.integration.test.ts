import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enabled,
  prepareDirectWebhookHTTPIntegrationFixture,
  closeDirectWebhookHTTPIntegrationFixture,
  seedWebhook,
  ownerQuery,
  sendWebhook,
} from './direct-webhook/direct-webhook.fixture.js';

beforeAll(prepareDirectWebhookHTTPIntegrationFixture, 60_000);
afterAll(closeDirectWebhookHTTPIntegrationFixture, 30_000);

describe.runIf(enabled)('coordinated webhook delivery history', () => {
  it('records the same 429 the sender sees when active-key capacity is exhausted, and accepts a fresh retry after recovery', async () => {
    const seeded = await seedWebhook('coordination-budget', {
      coordination: {
        mode: 'debounce',
        key: { kind: 'run_input', path: '$.key' },
        quietSeconds: 3600,
      },
    });
    await ownerQuery(
      `insert into app.trigger_event_windows(id,workspace_id,workflow_id,node_id,policy_hash,key_hash,window_started_at,expires_at)
      select gen_random_uuid(),$1,$2,'webhook',repeat('a',64),lpad(to_hex(n),64,'0'),clock_timestamp(),clock_timestamp()+interval '1 hour'
      from generate_series(1,10000) n`,
      [seeded.workspaceId, seeded.workflowId],
    );
    const body = Buffer.from('{"key":"new-key"}');
    const response = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      body,
      'capacity-retry',
    );
    expect(response.status).toBe(429);
    const deliveries = await ownerQuery(
      `select delivery.outcome,delivery.http_status,event.status,event.reason
      from app.webhook_trigger_deliveries delivery join app.trigger_coordinated_events event on event.id=delivery.coordination_event_id
      where delivery.workspace_id=$1`,
      [seeded.workspaceId],
    );
    expect(deliveries.rows).toEqual([
      {
        outcome: 'rate_limited',
        http_status: response.status,
        status: 'refused',
        reason: 'coordination_full',
      },
    ]);
    expect(
      (
        await ownerQuery(
          'select id from app.workflow_runs where workspace_id=$1',
          [seeded.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await ownerQuery(
          'select dedupe_key_hash from app.webhook_trigger_replay_records where workspace_id=$1',
          [seeded.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    await ownerQuery(
      'delete from app.trigger_event_windows where workspace_id=$1',
      [seeded.workspaceId],
    );
    expect(
      (
        await sendWebhook(
          seeded.endpointKey,
          seeded.originalSecret,
          body,
          'capacity-retry',
        )
      ).status,
    ).toBe(202);
  });
});
