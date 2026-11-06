import { randomBytes, randomUUID } from 'node:crypto';

import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createSlackClient } from '@pertexo/integrations/server';
import { connectionResponseSchema } from '@pertexo/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import { createEditorBrowserEnvelopeKeys } from '../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

const encoder = new TextEncoder();

describe.skipIf(!betterAuthIntegrationEnabled)(
  'failure-notification destination test on the real route',
  () => {
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const slackCalls: string[] = [];
    let slackBody: Record<string, unknown> = { ok: true };
    const api = useBetterAuthRealApi('destination_test_route', {
      connections: {
        config: {
          kmsKeyReference: 'owned-destination-fixture',
          region: 'us-east-1',
        },
        services: () => ({
          encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
          // Slack is the outside service; its parsing stays real.
          slack: createSlackClient({
            execute: async (request) => {
              await request.beforeDispatch();
              slackCalls.push(new URL(request.url).pathname);
              return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: encoder.encode(
                  JSON.stringify({
                    channel: 'C0123456789',
                    ts: '1760000000.000100',
                    ...slackBody,
                  }),
                ),
                bodyEncoding: 'utf8' as const,
                finalUrl: request.url,
                redirectCount: 0,
              };
            },
          }),
        }),
      },
    });
    afterAll(() => {
      keys.close();
    });

    it('pages through every destination after 100, including disabled entries', async () => {
      const { browser, workspaceId, destinationId } = await seedDestination();
      const connection = await api.database().connect();
      try {
        await connection.query('begin');
        await connection.query(
          `with copies as (
          insert into app.failure_notification_destinations(id,workspace_id,kind,status,current_config_version,created_by)
          select gen_random_uuid(),workspace_id,kind,'disabled',1,created_by from app.failure_notification_destinations
          cross join generate_series(1,100) where id=$1 returning *
        ) insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
          select c.workspace_id,c.id,1,v.kind,v.side_effect_class,v.config,c.created_by from copies c
          join app.failure_notification_destination_versions v on v.destination_id=$1 and v.version=1`,
          [destinationId],
        );
        await connection.query('commit');
      } finally {
        await connection.query('rollback');
        connection.release();
      }
      const path = `/v1/workspaces/${workspaceId}/failure-notification-destinations`;
      const first = await api.send('GET', path, { browser });
      expect(first.statusCode, first.payload).toBe(200);
      const page = first.json<{
        items: { id: string; status: string }[];
        nextCursor: string;
      }>();
      expect(page.items).toHaveLength(100);
      const second = await api.send(
        'GET',
        `${path}?afterId=${page.nextCursor}`,
        { browser },
      );
      expect(second.statusCode, second.payload).toBe(200);
      const last = second.json<{
        items: { id: string; status: string }[];
        nextCursor: null;
      }>();
      expect(last.items).toHaveLength(1);
      expect(last.nextCursor).toBeNull();
      const all = [...page.items, ...last.items];
      expect(new Set(all.map((row) => row.id)).size).toBe(101);
      expect(all.filter((row) => row.status === 'disabled')).toHaveLength(100);
      const invalid = await api.send('GET', `${path}?afterId=invalid`, {
        browser,
      });
      expect(invalid.statusCode).toBe(400);
    });

    it.each([
      ['null frame', "'null'::jsonb", 409, 'request.idempotency_conflict'],
      [
        'unreadable record',
        "jsonb_set(result_ref,'{result,createdAt}','\"not-a-date\"'::jsonb)",
        409,
        'request.idempotency_conflict',
      ],
      [
        'readable kind conflict',
        "jsonb_set(result_ref,'{result,kind}','\"email\"'::jsonb)",
        500,
        'internal.unexpected',
      ],
    ] as const)(
      'refuses a %s receipt without creating another destination',
      async (_case, damage, status, code) => {
        const { browser, workspaceId, destinationId } = await seedDestination();
        const connection = (
          await api
            .database()
            .query<{ id: string }>(
              `select config->>'connectionId' id from app.failure_notification_destination_versions where workspace_id=$1 and destination_id=$2 and version=1`,
              [workspaceId, destinationId],
            )
        ).rows[0];
        if (connection === undefined)
          throw new Error('Missing destination connection');
        const path = `/v1/workspaces/${workspaceId}/failure-notification-destinations`;
        const key = randomUUID();
        const create = () =>
          api.send('POST', path, {
            browser,
            headers: { 'Idempotency-Key': key },
            payload: {
              kind: 'slack',
              connectionId: connection.id,
              channelId: 'CRECEIPT',
            },
          });
        const first = await create();
        expect(first.statusCode, first.payload).toBe(201);
        const id = first.json<{ id: string }>().id;
        expect(
          (
            await api
              .database()
              .query(
                `update app.idempotency_records set result_ref=${damage} where workspace_id=$1 and resource_id=$2 and operation='failure.notification.destination.create'`,
                [workspaceId, id],
              )
          ).rowCount,
        ).toBe(1);
        const replay = await create();
        const count = (
          await api
            .database()
            .query<{ count: number }>(
              'select count(*)::int count from app.failure_notification_destinations where workspace_id=$1',
              [workspaceId],
            )
        ).rows[0]?.count;
        expect({
          status: replay.statusCode,
          code: replay.json<{ code?: string }>().code,
          destinations: count,
        }).toEqual({ status, code, destinations: 2 });
      },
    );

    async function seedDestination() {
      const email = `destination-test-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          name: 'Destination test route',
          slug: `route-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const { id: workspaceId } = workspace.json<{ id: string }>();
      const connection = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/connections`,
        {
          browser,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: {
            providerKey: 'slack',
            name: 'Incident Slack',
            credential: {
              type: 'slack_bot_token',
              botToken: 'xoxb-owned-fixture-token-1',
            },
          },
        },
      );
      expect(connection.statusCode, connection.payload).toBe(201);
      const destination = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        {
          browser,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: {
            kind: 'slack',
            connectionId: connectionResponseSchema.parse(connection.json()).id,
            channelId: 'C0123456789',
          },
        },
      );
      expect(destination.statusCode, destination.payload).toBe(201);
      const { id: destinationId } = destination.json<{ id: string }>();
      return {
        browser,
        workspaceId,
        destinationId,
        send: () =>
          api.send(
            'POST',
            `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/test`,
            {
              browser,
              headers: { 'Idempotency-Key': randomUUID() },
              payload: {
                expectedVersion: 1,
                sideEffectDisclosureAccepted: true,
              },
            },
          ),
      };
    }

    it('sends one real message to a real Slack destination and reports it', async () => {
      slackBody = { ok: true };
      const before = slackCalls.length;
      const { send } = await seedDestination();
      const response = await send();
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toMatchObject({ outcome: { ok: true } });
      expect(slackCalls.slice(before)).toContain('/api/chat.postMessage');
    }, 60_000);

    it('reports the service refusing the message as that, not as a server failure', async () => {
      slackBody = { ok: false, error: 'channel_not_found' };
      const { send } = await seedDestination();
      const response = await send();
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toMatchObject({ outcome: { ok: false } });
    }, 60_000);
  },
);
