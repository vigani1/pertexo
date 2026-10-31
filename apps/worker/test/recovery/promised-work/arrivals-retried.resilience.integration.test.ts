import { EVENT_COORDINATION_LIMITS } from '@pertexo/workflow-model';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { nextStep } from '../../support/recovery/flows.js';
import { triggeredChain } from '../../support/recovery/graphs.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import { waitForWebhookKeys } from '../../support/recovery/triggers.js';

const QUIET_SECONDS = 3_600;
const EVENT_KEY = 'order-retried';

/**
 * A 429 is only worth anything if the retry it asks for can work. The sender
 * repeats the same request with the same key, so a refusal kept as the answer to
 * that key would turn the retry into the same 429 for as long as the record lives.
 */
describeFaults('a sender retrying after the server was full', () => {
  let stack: Stack;
  let refused: number;
  let retryAfter: string | null;
  let stillFull: number;
  let retried: Readonly<{ status: number; json: unknown }>;
  let keptEvents: number;

  beforeAll(async () => {
    stack = await startStack('arrivals-retried');
    const workspace = await stack.api.createWorkspace('recovery-retried');
    const debounced = await stack.api.publish(
      workspace,
      'debounced',
      triggeredChain(
        {
          key: 'core.webhook',
          config: {
            coordination: {
              mode: 'debounce',
              key: { kind: 'run_input', path: '$.customer' },
              quietSeconds: QUIET_SECONDS,
            },
          },
        },
        [nextStep(stack, 'debounced')],
      ),
    );
    const keys = await waitForWebhookKeys(stack, workspace, debounced);
    await stack.api.sendWebhook(keys, { customer: 'first' });
    await stack.sql(
      `with first_event as (
         select * from app.trigger_coordinated_events
          where workflow_id=$1 and status='pending'
       ), room as (
         select gen_random_uuid() as key_id, n
           from generate_series(1, $2::int) n
       ), windows as (
         insert into app.trigger_event_windows
         select (jsonb_populate_record(w, jsonb_build_object(
                  'id', room.key_id,
                  'key_hash', encode(sha256(n::text::bytea), 'hex')))).*
           from app.trigger_event_windows w
           join first_event on first_event.key_id=w.id
          cross join room
       )
       insert into app.trigger_coordinated_events
       select (jsonb_populate_record(
                null::app.trigger_coordinated_events,
                to_jsonb(first_event) || jsonb_build_object(
                  'id', gen_random_uuid(), 'key_id', room.key_id))).*
         from first_event cross join room`,
      [debounced, EVENT_COORDINATION_LIMITS.pendingEvents - 1],
    );

    const event = { customer: 'retried' };
    const full = await stack.api.sendWebhook(keys, event, EVENT_KEY);
    refused = full.status;
    retryAfter = full.retryAfter;
    stillFull = (await stack.api.sendWebhook(keys, event, EVENT_KEY)).status;

    // Room again: the stand-in rows have no delivery of their own to answer for.
    await stack.sql(
      `delete from app.trigger_coordinated_events e
        where e.workflow_id=$1 and e.status='pending'
          and not exists(select 1 from app.webhook_trigger_replay_records r
                          where r.coordination_event_id=e.id)`,
      [debounced],
    );
    retried = await stack.api.sendWebhook(keys, event, EVENT_KEY);
    const [pending] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.trigger_coordinated_events
        where workflow_id=$1 and status='pending'`,
      [debounced],
    );
    keptEvents = pending?.count ?? 0;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('says when to try again', () => {
    expect(refused).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('keeps saying so for as long as there is no room', () => {
    expect(stillFull).toBe(429);
  });

  it('accepts the same request once there is room, and keeps it', () => {
    expect(retried.status).toBe(202);
    expect(retried.json).toMatchObject({
      coordinated: true,
      status: 'pending',
    });
    // The first event and this one.
    expect(keptEvents).toBe(2);
  });
});
