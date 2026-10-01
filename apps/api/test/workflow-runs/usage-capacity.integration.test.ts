import { randomUUID } from 'node:crypto';
import type { UsageCapacityResponse } from '@pertexo/contracts/workflow-runs';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
} from '../support/better-auth-real-api.integration.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'workspace usage capacity real HTTP authority',
  () => {
    const api = useBetterAuthRealApi('usage-capacity');

    it('reports current authoritative limits, exact charges and active-only member isolation', async () => {
      const ownerEmail = `${randomUUID()}@example.test`;
      const viewerEmail = `${randomUUID()}@example.test`;
      const outsiderEmail = `${randomUUID()}@example.test`;
      for (const email of [ownerEmail, viewerEmail, outsiderEmail]) {
        await api.signUp(email, '/login?verified=true');
      }
      const owner = await api.signIn(ownerEmail);
      const viewer = await api.signIn(viewerEmail);
      const outsider = await api.signIn(outsiderEmail);
      const created = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Usage capacity',
          slug: `usage-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const viewerId = (
        await api.send('GET', '/v1/users/me', { browser: viewer })
      ).json<{ id: string }>().id;
      await api
        .database()
        .query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')`,
          [workspaceId, viewerId],
        );
      const route = `/v1/workspaces/${workspaceId}/usage-capacity`;
      expectProblem(await api.send('GET', route), 401, 'auth.unauthenticated');
      expectProblem(
        await api.send('GET', route, { browser: outsider }),
        404,
        'resource.not_found',
      );
      const fresh = await api.send('GET', route, { browser: viewer });
      expect(fresh.statusCode, fresh.payload).toBe(200);
      expect(fresh.headers['cache-control']).toBe('private, no-store');
      expect(fresh.json<UsageCapacityResponse>()).toMatchObject({
        execution: {
          activeRuns: 0,
          reservedActiveSlots: 0,
          activeCapacityConsumed: 0,
          queuedRuns: 0,
          policy: {
            state: 'active',
            version: 1,
            activeRunLimit: 5,
            queuedRunLimit: 100,
          },
        },
        artifacts: {
          chargedBytes: '0',
          byteLimit: '1073741824',
          chargedCount: 0,
          artifactCountLimit: 1000,
          source: 'default',
        },
      });
      await api
        .database()
        .query(
          `insert into app.workspace_artifact_capacity(workspace_id,charged_bytes,byte_limit,charged_count,artifact_count_limit) values($1,9007199254740993,0,3,0)`,
          [workspaceId],
        );
      const stored = await api.send('GET', route, { browser: viewer });
      expect(stored.statusCode, stored.payload).toBe(200);
      expect(stored.json<UsageCapacityResponse>().artifacts).toEqual({
        chargedBytes: '9007199254740993',
        byteLimit: '0',
        chargedCount: 3,
        artifactCountLimit: 0,
        source: 'stored',
      });
      await api
        .database()
        .query(
          `delete from app.workspace_execution_entitlements where workspace_id=$1`,
          [workspaceId],
        );
      const unavailable = await api.send('GET', route, { browser: owner });
      expect(unavailable.statusCode, unavailable.payload).toBe(200);
      expect(
        unavailable.json<UsageCapacityResponse>().execution.policy,
      ).toEqual({
        state: 'unavailable',
        version: null,
        activeRunLimit: null,
        queuedRunLimit: null,
      });
      for (const status of ['suspended', 'pending_deletion']) {
        await api.database().query(
          `update app.workspaces set status=$2::text,
            deletion_requested_at=case when $2::text='pending_deletion' then clock_timestamp() else null end,
            deletion_requested_by=case when $2::text='pending_deletion' then created_by else null end,
            deletion_reason=case when $2::text='pending_deletion' then 'integration isolation' else null end,
            purge_after=case when $2::text='pending_deletion' then clock_timestamp()+interval '7 days' else null end
            where id=$1`,
          [workspaceId, status],
        );
        // Lifecycle transitions revoke prior sessions; use a fresh authenticated
        // viewer to exercise workspace authorization rather than session expiry.
        const currentViewer = await api.signIn(viewerEmail);
        expectProblem(
          await api.send('GET', route, { browser: currentViewer }),
          404,
          'resource.not_found',
        );
        const activity = await api.send(
          'GET',
          `/v1/workspaces/${workspaceId}/run-statistics`,
          { browser: currentViewer },
        );
        expect(activity.statusCode, activity.payload).toBe(200);
      }
    });
  },
);
