import { randomBytes, randomUUID } from 'node:crypto';

import {
  ConnectionEnvelopeEncryption,
  createSlackClient,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
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

    // api-design-01: the route's rate class needs a connection the route doesn't carry, so every call is a 500.
    it.fails(
      'sends one real message to a real Slack destination and reports it',
      async () => {
        slackBody = { ok: true };
        const before = slackCalls.length;
        const { send } = await seedDestination();
        const response = await send();
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toMatchObject({ outcome: { ok: true } });
        expect(slackCalls.slice(before)).toContain('/api/chat.postMessage');
      },
      60_000,
    );

    // api-design-01: the same 500 hides the service's own refusal.
    it.fails(
      'reports the service refusing the message as that, not as a server failure',
      async () => {
        slackBody = { ok: false, error: 'channel_not_found' };
        const { send } = await seedDestination();
        const response = await send();
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toMatchObject({ outcome: { ok: false } });
      },
      60_000,
    );
  },
);
