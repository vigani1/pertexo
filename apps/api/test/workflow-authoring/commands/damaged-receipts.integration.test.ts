import { randomUUID } from 'node:crypto';

import { portableGraphDigest } from '@pertexo/workflow-model';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
  type Browser,
  type Reply,
} from '../../support/better-auth/real-api.support.js';
import { emptyWorkflowGraph } from '../../workspaces/real-api/graphs.js';

/**
 * Core's tests stop at the store's error. These prove what the caller gets: the
 * same 409 through each flow's real route, never a 500 or a "not found" for
 * something that exists.
 */
describe.skipIf(!betterAuthIntegrationEnabled)(
  'a damaged receipt reaching a route',
  () => {
    const api = useBetterAuthRealApi('damaged_receipts');
    let owner: Browser;
    let root: string;
    let workspaceId: string;

    type Sent = Readonly<{
      method: 'POST' | 'PUT';
      url: string;
      payload?: object;
      headers?: Readonly<Record<string, string>>;
    }>;

    /** The first attempt lands, its receipt is damaged, and the exact retry is sent. */
    async function retryOverDamage(operation: string, sent: Sent) {
      const headers = { 'idempotency-key': randomUUID(), ...sent.headers };
      const send = () =>
        api.send(sent.method, sent.url, {
          browser: owner,
          headers,
          ...(sent.payload === undefined ? {} : { payload: sent.payload }),
        });
      const first = await send();
      expect(first.statusCode, first.payload).toBeLessThan(300);
      const { rowCount } = await api.database().query(
        `update app.idempotency_records set result_ref='{"damaged":true}'::jsonb
           where workspace_id=$1 and operation=$2 and status='completed'`,
        [workspaceId, operation],
      );
      expect(rowCount).toBeGreaterThan(0);
      return send();
    }

    function expectConflict(reply: Reply) {
      expectProblem(reply, 409, 'request.idempotency_conflict');
    }

    async function newWorkflow() {
      const made = await api.send('POST', `${root}/workflows`, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: `Receipts ${randomUUID()}` },
      });
      expect(made.statusCode, made.payload).toBe(201);
      return {
        id: made.json<{ workflow: { id: string } }>().workflow.id,
        tag: String(made.headers.etag),
      };
    }

    async function savedWorkflow() {
      const { id, tag } = await newWorkflow();
      const saved = await api.send('PUT', `${root}/workflows/${id}/draft`, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID(), 'if-match': tag },
        payload: { graph: emptyWorkflowGraph() },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      return { id, tag: String(saved.headers.etag) };
    }

    beforeAll(async () => {
      const email = `damaged-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      owner = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Damaged receipts',
          slug: `damaged-${randomUUID().slice(0, 12)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      workspaceId = workspace.json<{ id: string }>().id;
      root = `/v1/workspaces/${workspaceId}`;
    }, 60_000);

    it('creating a workflow', async () => {
      expectConflict(
        await retryOverDamage('workflow.create', {
          method: 'POST',
          url: `${root}/workflows`,
          payload: { name: 'Twice' },
        }),
      );
    });

    it('duplicating a workflow', async () => {
      const { id, tag } = await savedWorkflow();
      expectConflict(
        await retryOverDamage('workflow.duplicate', {
          method: 'POST',
          url: `${root}/workflows/${id}/duplicate`,
          headers: { 'if-match': tag },
          payload: { name: 'A copy', source: { kind: 'draft' } },
        }),
      );
    });

    it('publishing a workflow', async () => {
      const { id, tag } = await savedWorkflow();
      expectConflict(
        await retryOverDamage('workflow.publish', {
          method: 'POST',
          url: `${root}/workflows/${id}/publish`,
          headers: { 'if-match': tag },
        }),
      );
    });

    it('renaming a workflow', async () => {
      const { id } = await newWorkflow();
      expectConflict(
        await retryOverDamage('workflow.rename', {
          method: 'POST',
          url: `${root}/workflows/${id}/rename`,
          payload: { name: 'Renamed', expectedNameRevision: 1 },
        }),
      );
    });

    it('archiving a workflow', async () => {
      const { id } = await newWorkflow();
      expectConflict(
        await retryOverDamage('workflow.archive', {
          method: 'POST',
          url: `${root}/workflows/${id}/archive`,
          payload: { expectedLifecycleRevision: 1 },
        }),
      );
    });

    it("changing a workflow's auto-pause", async () => {
      const { id } = await newWorkflow();
      expectConflict(
        await retryOverDamage('workflow.autopause.settings', {
          method: 'PUT',
          url: `${root}/workflows/${id}/auto-pause`,
          payload: {
            enabled: true,
            thresholdOverride: 7,
            expectedSettingsRevision: 1,
          },
        }),
      );
    });

    it("resuming a workflow's triggers", async () => {
      const { id } = await newWorkflow();
      expectConflict(
        await retryOverDamage('workflow.autopause.resume', {
          method: 'POST',
          url: `${root}/workflows/${id}/resume`,
          payload: { expectedPauseRevision: '1' },
        }),
      );
    });

    it("changing the workspace's auto-pause default", async () => {
      const current = await api.send('GET', `${root}/auto-pause`, {
        browser: owner,
      });
      const { revision } = current.json<{ revision: number }>();
      expectConflict(
        await retryOverDamage('workspace.autopause.settings', {
          method: 'PUT',
          url: `${root}/auto-pause`,
          payload: { threshold: 42, expectedRevision: revision },
        }),
      );
    });

    it('creating a folder', async () => {
      expectConflict(
        await retryOverDamage('folder.create', {
          method: 'POST',
          url: `${root}/workflow-folders`,
          payload: { name: 'Twice', parentId: null },
        }),
      );
    });

    it('creating a tag', async () => {
      expectConflict(
        await retryOverDamage('tag.create', {
          method: 'POST',
          url: `${root}/workflow-tags`,
          payload: { key: 'twice' },
        }),
      );
    });

    it('importing a workflow', async () => {
      const { id, tag } = await savedWorkflow();
      const graph = (
        await api.send('GET', `${root}/workflows/${id}/draft`, {
          browser: owner,
        })
      ).json<{ graph: Parameters<typeof portableGraphDigest>[0] }>().graph;
      const exported = await api.send(
        'POST',
        `${root}/workflows/${id}/export`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID(), 'if-match': tag },
          payload: {
            source: { kind: 'draft' },
            reviewedGraphDigest: await portableGraphDigest(graph),
          },
        },
      );
      expect(exported.statusCode, exported.payload).toBe(200);
      const manifest = exported.json<object>();
      const preview = await api.send(
        'POST',
        `${root}/workflows/import/preview`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { manifest, bindings: [] },
        },
      );
      expect(preview.statusCode, preview.payload).toBe(200);
      expectConflict(
        await retryOverDamage('workflow.import', {
          method: 'POST',
          url: `${root}/workflows/import`,
          payload: {
            manifest,
            bindings: [],
            name: 'Imported twice',
            expectedCompatibilityFingerprint: preview.json<{
              compatibilityFingerprint: string;
            }>().compatibilityFingerprint,
          },
        }),
      );
    });

    it('choosing a promotion target', async () => {
      const target = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Target',
          slug: `target-${randomUUID().slice(0, 12)}`,
        },
      });
      expect(target.statusCode, target.payload).toBe(201);
      expectConflict(
        await retryOverDamage('workspace.promotion.target', {
          method: 'PUT',
          url: `${root}/promotions/settings`,
          payload: {
            expectedRevision: 0,
            expectedTargetWorkspaceId: null,
            targetWorkspaceId: target.json<{ id: string }>().id,
          },
        }),
      );
    });
  },
);
