import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectionUsageResponseSchema } from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from './support/better-auth-real-api.integration.support.js';
import { useConnectionHealthFixture } from './support/connection-health.fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'real connection health and authorized usage HTTP',
  () => {
    const fixture = useConnectionHealthFixture('connection_health_http', {
      abandonPublicationBeforeRestart: true,
    });
    it('pages usage, recovers an abandoned health publication after real lease expiry and runtime restart, and denies unauthorized reads', async () => {
      const { workspaceId, connectionId, browser } = await fixture.seed();
      const route = `/v1/workspaces/${workspaceId}/connections/${connectionId}/usage`;
      const first = await fixture.api.send('GET', `${route}?limit=1`, {
        browser,
      });
      expect(first.statusCode, first.payload).toBe(200);
      const page1 = connectionUsageResponseSchema.parse(first.json());
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();
      if (page1.nextCursor === null)
        throw new Error('Expected bounded usage cursor');
      const second = await fixture.api.send(
        'GET',
        `${route}?limit=1&after=${page1.nextCursor}`,
        { browser },
      );
      expect(second.statusCode, second.payload).toBe(200);
      const page2 = connectionUsageResponseSchema.parse(second.json());
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      const items = [...page1.items, ...page2.items];
      expect(new Set(items.map((row) => row.workflowVersionId)).size).toBe(2);
      expect(items.map((row) => row.versionNumber).sort()).toEqual([1, 2]);
      expect(
        items
          .filter((row) => row.isCurrentPublication)
          .map((row) => row.versionNumber),
      ).toEqual([2]);
      expect(
        items.every((row) => row.operationKeys.join(',') === 'send_message'),
      ).toBe(true);
      expect(first.payload + second.payload).not.toMatch(
        /xoxb|credential|secretVersion|graph_json/iu,
      );
      expect((await fixture.api.send('GET', route)).statusCode).toBe(401);
      expect(
        (
          await fixture.api.send(
            'GET',
            route.replace(workspaceId, randomUUID()),
            { browser },
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await fixture.api.send(
            'GET',
            `${route.replace(connectionId, randomUUID())}?after=${page1.nextCursor}`,
            { browser },
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await fixture.api.send('GET', `${route}?limit=101`, { browser }))
          .statusCode,
      ).toBe(400);
      expect(await fixture.commandFor('/reject-run')).toEqual({
        restarted: true,
        abandonedPublicationRecovered: true,
        providerCalls: 1,
      });
      const connection = await fixture.readConnection();
      expect(connection.status).toBe('reauthorization_required');
      expect(connection.health.lastRunObservedAt).not.toBeNull();
      expect(connection.health.lastTestedAt).toBeNull();
      expect(connection.health.lastHealthTransitionSource).toBe('run');
      await fixture.commandFor('/deny-membership');
      expect(
        (await fixture.api.send('GET', route, { browser })).statusCode,
      ).toBe(404);
      expect(fixture.providerCalls).toBe(1);
    }, 90000);
  },
);
