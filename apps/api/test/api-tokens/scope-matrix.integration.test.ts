import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  useQualificationApi,
  type World,
} from './qualification/qualification-api.fixture.js';
import { routes } from './qualification/routes.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'all 27 Step 5 token route boundaries',
  () => {
    const { api, setup } = useQualificationApi();
    let world: World;
    beforeAll(async () => {
      world = await setup();
    }, 60000);
    it.each(routes)(
      '$name rejects a wrong scope and a foreign workspace before consuming a command',
      async (route) => {
        const wrong = await world.credential(['run:read']);
        const reply = await api.send(route.method, route.path(world), {
          headers: { ...wrong, 'idempotency-key': randomUUID() },
          ...(route.body === undefined
            ? {}
            : {
                payload:
                  typeof route.body === 'function'
                    ? route.body(world)
                    : route.body,
              }),
        });
        expect(reply.statusCode, reply.payload).toBe(403);
        expect(reply.json()).toMatchObject({
          code: 'auth.token_scope_required',
        });
        const own = await world.credential(route.scopes);
        const foreign = await api.send(
          route.method,
          route.path(world).replace(world.workspaceId, randomUUID()),
          {
            headers: { ...own, 'idempotency-key': randomUUID() },
            ...(route.body === undefined
              ? {}
              : {
                  payload:
                    typeof route.body === 'function'
                      ? route.body(world)
                      : route.body,
                }),
          },
        );
        expect(foreign.statusCode, foreign.payload).toBe(404);
      },
    );
    it('accepts every route with only its narrowest required scopes', async () => {
      expect(routes).toHaveLength(27);
      for (const route of routes) {
        const headers = await world.credential(route.scopes);
        let payload =
          typeof route.body === 'function' ? route.body(world) : route.body;
        if (route.name === 'remove table') {
          const listed = await api.send('GET', `${world.base}/data-tables`, {
            headers: await world.credential(['workspace:read']),
          });
          const table = listed
            .json<{ tables: { id: string; revision: number }[] }>()
            .tables.find((table) => table.id === world.tableId);
          if (table === undefined)
            throw new Error('Table disappeared before removal');
          payload = { expectedRevision: table.revision };
        }
        const response = await api.send(route.method, route.path(world), {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(response.statusCode, `${route.name}: ${response.payload}`).toBe(
          route.status,
        );
      }
    });
    it('requires both variable-reference read scopes and grants no workflow reads from workspace or variable authority', async () => {
      for (const scopes of [
        ['workspace:read'],
        ['workflow:read'],
        ['variable:manage'],
      ] as const) {
        const headers = await world.credential(scopes);
        const usage = await api.send(
          'GET',
          `${world.base}/variables/usage?name=REGION`,
          { headers },
        );
        expect(usage.statusCode, usage.payload).toBe(403);
        expect(usage.json()).toMatchObject({
          code: 'auth.token_scope_required',
        });
        if (scopes[0] !== 'workflow:read') {
          const workflow = await api.send(
            'GET',
            `${world.base}/workflows/${world.workflowId}`,
            { headers },
          );
          expect(workflow.statusCode, workflow.payload).toBe(403);
          expect(workflow.json()).toMatchObject({
            code: 'auth.token_scope_required',
          });
        }
      }
    });

    it('publishes the scopes independently qualified by each of the 27 real operations', async () => {
      const response = await api.send('GET', '/v1/openapi.json');
      expect(response.statusCode, response.payload).toBe(200);
      const document = response.json<{
        paths: Record<
          string,
          Record<
            string,
            { operationId: string; 'x-pertexo-api-token-scopes': string[] }
          >
        >;
      }>();
      const operations = Object.values(document.paths).flatMap((path) =>
        Object.values(path),
      );
      for (const route of routes) {
        const matched = operations.filter(
          (operation) => operation.operationId === route.operationId,
        );
        expect(matched, route.operationId).toHaveLength(1);
        expect(
          matched[0]?.['x-pertexo-api-token-scopes'].toSorted(),
          route.operationId,
        ).toEqual(route.scopes.toSorted());
      }
    });
  },
);
