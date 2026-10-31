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

type Answer = Readonly<{ status: number; body: unknown }>;
type Refusal = Readonly<{ reason: string; status: string }>;

/**
 * The one way an event goes for good after a 2xx. Nothing is durable for it: it is
 * refused, and the sender has no way to know that from the status it acts on. For
 * a sender's own mistake that's a documented answer (F25). For a server that is
 * full it loses events a retry would have saved, which webhook senders are built
 * to do on a 429 or 503 and never on a 202.
 */
describeFaults('events refused when they arrive', () => {
  let stack: Stack;
  let accepted: number;
  let overCapacity: Answer;
  let badKey: Answer;
  let refusals: readonly Refusal[];

  beforeAll(async () => {
    stack = await startStack('arrivals-refused');
    const workspace = await stack.api.createWorkspace('recovery-refused');
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

    const answer = async (event: unknown): Promise<Answer> => {
      const { json, status } = await stack.api.sendWebhook(keys, event);
      return { body: json, status };
    };
    badKey = await answer({ order: 'no customer' });

    // Sending them all would meet the API's rate limit first, which answers a 429 and
    // proves nothing here. So one real event, and the same row for the rest of the room.
    const first = await answer({ customer: 'first' });
    accepted = first.status;
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
    overCapacity = await answer({ customer: 'one-too-many' });

    refusals = await stack.sql<Refusal>(
      `select status, reason from app.trigger_coordinated_events
        where workflow_id=$1 and status='refused' order by received_at`,
      [debounced],
    );
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('accepts every event while there is room', () => {
    expect(accepted).toBe(202);
  });

  // F25: a key the sender got wrong will not get better by retrying.
  it('tells a sender its event had no usable key, and records it', () => {
    expect(badKey.status).toBe(202);
    expect(badKey.body).toMatchObject({
      coordinated: true,
      reason: 'invalid_key',
      status: 'refused',
    });
    expect(refusals[0]).toEqual({ reason: 'invalid_key', status: 'refused' });
  });

  it('records the refused event in the history', () => {
    expect(refusals[1]).toEqual({
      reason: 'coordination_full',
      status: 'refused',
    });
  });

  // reliability-code-01: a 202 here loses the event for good, and a 429 would have saved it.
  it.fails('tells a sender to try again when there is no room', () => {
    expect([429, 503]).toContain(overCapacity.status);
  });
});
