import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { useQualificationApi } from './qualification/fixture.js';
import { routes } from './qualification/routes.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'Step 5 routes retain current workspace authority',
  () => {
    const { api, setup } = useQualificationApi();
    it('refuses every token route while the workspace is suspended', async () => {
      const w = await setup();
      for (const route of routes) await w.credential(route.scopes);
      await api
        .database()
        .query("update app.workspaces set status='suspended' where id=$1", [
          w.workspaceId,
        ]);
      for (const route of routes) {
        const response = await api.send(route.method, route.path(w), {
          headers: {
            ...(await w.credential(route.scopes)),
            'idempotency-key': randomUUID(),
          },
          ...(route.body === undefined
            ? {}
            : {
                payload:
                  typeof route.body === 'function' ? route.body(w) : route.body,
              }),
        });
        expect(response.statusCode, `${route.name}: ${response.payload}`).toBe(
          401,
        );
      }
    });
    it.each(['downgrade', 'removal', 'rejoin'] as const)(
      'permanently refuses old credentials after %s on every added route',
      async (change) => {
        const w = await setup();
        const credentials = new Map<string, Record<string, string>>();
        for (const route of routes)
          credentials.set(route.name, await w.credential(route.scopes));
        const remainingOwner = randomUUID();
        await api
          .database()
          .query(
            "insert into app.users(id,email,display_name,email_verified) values($1,$2,'Remaining owner',true)",
            [remainingOwner, `${remainingOwner}@example.test`],
          );
        const transaction = await api.database().connect();
        try {
          await transaction.query('begin');
          if (change === 'downgrade')
            await transaction.query(
              "update app.workspace_memberships set role='viewer',role_revision=role_revision+1 where workspace_id=$1 and user_id=(select id from app.users where email=$2)",
              [w.workspaceId, w.email],
            );
          else {
            await transaction.query(
              "update app.workspace_memberships set role='admin',status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=(select id from app.users where email=$2)",
              [w.workspaceId, w.email],
            );
            if (change === 'rejoin')
              await transaction.query(
                "update app.workspace_memberships set status='active',role_revision=role_revision+1 where workspace_id=$1 and user_id=(select id from app.users where email=$2)",
                [w.workspaceId, w.email],
              );
          }
          await transaction.query(
            "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
            [w.workspaceId, remainingOwner],
          );
          await transaction.query('commit');
        } finally {
          await transaction.query('rollback');
          transaction.release();
        }
        for (const route of routes) {
          const response = await api.send(route.method, route.path(w), {
            headers: {
              ...credentials.get(route.name),
              'idempotency-key': randomUUID(),
            },
            ...(route.body === undefined
              ? {}
              : {
                  payload:
                    typeof route.body === 'function'
                      ? route.body(w)
                      : route.body,
                }),
          });
          expect(
            response.statusCode,
            `${route.name}: ${response.payload}`,
          ).toBe(401);
          expect(response.json()).toMatchObject({
            code: 'auth.unauthenticated',
          });
        }
      },
    );
  },
);
