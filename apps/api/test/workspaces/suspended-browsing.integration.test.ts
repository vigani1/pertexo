import {
  portableGraphDigest,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { describe, it, beforeAll, expect } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';
import { emptyWorkflowGraph } from './real-api/graphs.js';
import {
  HIDDEN,
  READS_CLOSED_TODAY,
  READS_OPEN_TODAY,
  READS_OPEN_UNTIL_PURGE,
  expectShown,
  type Read,
} from './suspended/suspended-workspace-reads.js';
import { AUTHORING_WRITES } from './suspended/authoring-writes.js';
import { WRITES, durableWorkspaceFacts } from './suspended/writes.js';
import {
  apiHeaders,
  seedWorld,
  setStatus,
  type World,
  type WorkspaceStatus,
} from './suspended/world.js';

/**
 * A restored workspace comes back `suspended` (ADR 013/027), and its banner says
 * "You can look around". These hold it to that: the pages read, nothing changes.
 */
describe.skipIf(!betterAuthIntegrationEnabled)(
  'browsing a suspended workspace',
  () => {
    const api = useBetterAuthRealApi('suspended_browsing', {
      automationTokens: true,
      notifications: true,
      connections: {
        config: {
          mode: 'self-managed',
          encryption: {
            current: {
              version: 'fixture-v1',
              key: Buffer.alloc(32, 77).toString('base64'),
            },
            previous: [],
          },
        },
      },
    });
    let world: World;
    let owner: Browser;
    let viewer: Browser;

    beforeAll(async () => {
      world = await seedWorld(api);
    }, 60_000);

    /** Lifecycle changes end sessions, so each state starts with fresh ones. */
    async function enter(status: WorkspaceStatus) {
      await setStatus(api, world.workspaceId, status);
      owner = await api.signIn(world.ownerEmail);
      viewer = await api.signIn(world.viewerEmail);
    }

    function read(entry: Read) {
      const browser = entry.as === 'owner' ? owner : viewer;
      return entry.query === undefined
        ? api.send('GET', entry.path(world), { browser })
        : api.send('POST', entry.path(world), {
            browser,
            payload: entry.query,
          });
    }

    function sendWrite(write: (typeof WRITES)[number]) {
      return api.send(write.method, write.path(world), {
        browser: owner,
        headers: apiHeaders(write.headers?.(world)),
        ...(write.payload === undefined
          ? {}
          : { payload: write.payload(world) }),
      });
    }

    function publicForm(method: 'GET' | 'POST') {
      return api.send(
        method,
        `/v1/forms/${world.formPublicId}${method === 'POST' ? '/submit' : ''}`,
        {
          headers: {
            'x-pertexo-form-key': world.formCapability,
            ...(method === 'POST' ? apiHeaders() : {}),
          },
          ...(method === 'POST'
            ? {
                payload: {
                  versionId: world.formVersionId,
                  values: { note: 'a stranger' },
                },
              }
            : {}),
        },
      );
    }

    describe('while it is active', () => {
      beforeAll(() => enter('active'));

      for (const entry of [...READS_OPEN_TODAY, ...READS_CLOSED_TODAY])
        it(`shows ${entry.name}`, async () => {
          expectShown(entry, await read(entry), world);
        });

      it('takes a public form submission', async () => {
        const accepted = await publicForm('POST');
        expect(accepted.statusCode, accepted.payload).toBe(200);
      });
    });

    describe('while it is suspended', () => {
      beforeAll(() => enter('suspended'));

      for (const entry of READS_OPEN_TODAY)
        it(`shows ${entry.name}`, async () => {
          expectShown(entry, await read(entry), world);
        });

      for (const entry of READS_CLOSED_TODAY)
        it(`shows ${entry.name}`, async () => {
          expectShown(entry, await read(entry), world);
        });

      it('exports a retained immutable version without changing suspended workspace facts', async () => {
        const base = `/v1/workspaces/${world.workspaceId}/workflows/${world.workflowId}`;
        const versions = await api.send('GET', `${base}/versions?limit=10`, {
          browser: owner,
        });
        expect(versions.statusCode, versions.payload).toBe(200);
        const version = versions
          .json<{ items: { id: string; graph: WorkflowGraph }[] }>()
          .items.find(({ id }) => id === world.versionId);
        if (version === undefined)
          throw new Error('Expected retained fixture version');
        const before = (
          await api.database().query(durableWorkspaceFacts, [world.workspaceId])
        ).rows;
        const exported = await api.send('POST', `${base}/export`, {
          browser: owner,
          headers: apiHeaders(),
          payload: {
            source: { kind: 'version', versionId: world.versionId },
            reviewedGraphDigest: await portableGraphDigest(version.graph),
          },
        });
        expect(exported.statusCode, exported.payload).toBe(200);
        expect(exported.json()).toMatchObject({
          format: 'pertexo.workflow',
          graph: version.graph,
        });
        expect(
          (
            await api
              .database()
              .query(durableWorkspaceFacts, [world.workspaceId])
          ).rows,
        ).toEqual(before);
      });

      it('keeps what a role does not grant from a viewer', async () => {
        const { workspaceId } = world;
        expectProblem(
          await api.send('GET', `/v1/workspaces/${workspaceId}/members`, {
            browser: viewer,
          }),
          403,
          'auth.forbidden',
        );
        expectProblem(
          await api.send(
            'GET',
            `/v1/workspaces/${workspaceId}/governance/audit`,
            { browser: viewer },
          ),
          404,
          'resource.not_found',
        );
      });

      describe('and something tries to change it', () => {
        let before: unknown;

        beforeAll(async () => {
          before = (
            await api
              .database()
              .query(durableWorkspaceFacts, [world.workspaceId])
          ).rows[0];
        });

        for (const write of [
          ...WRITES,
          ...AUTHORING_WRITES.filter((one) => !WRITES.includes(one)),
        ])
          it(`refuses ${write.name}`, async () => {
            const refused = await sendWrite(write);
            if (write.forbidden === true)
              expectProblem(refused, 403, 'auth.forbidden');
            else expectProblem(refused, 404, 'resource.not_found');
          });

        it('refuses a public form', async () => {
          expectProblem(await publicForm('GET'), 404, 'form.unavailable');
          expectProblem(await publicForm('POST'), 404, 'form.unavailable');
        });

        it('has changed nothing after all of those', async () => {
          const after = await api
            .database()
            .query(durableWorkspaceFacts, [world.workspaceId]);
          expect(after.rows[0]).toEqual(before);
        });
      });
    });

    describe('while it is scheduled for deletion', () => {
      beforeAll(() => enter('pending_deletion'));
      it('refuses retained export after browsing closes', async () => {
        const refused = await api.send(
          'POST',
          `/v1/workspaces/${world.workspaceId}/workflows/${world.workflowId}/export`,
          {
            browser: owner,
            headers: apiHeaders(),
            payload: {
              source: { kind: 'version', versionId: world.versionId },
              reviewedGraphDigest:
                await portableGraphDigest(emptyWorkflowGraph()),
            },
          },
        );
        expectProblem(refused, 404, 'resource.not_found');
      });

      for (const entry of READS_OPEN_UNTIL_PURGE)
        it(`shows ${entry.name}`, async () => {
          expectShown(entry, await read(entry), world);
        });

      // The rest of READS_OPEN_TODAY answer here too: their guards allow this
      // state on purpose or by habit, and nothing here decides which, so none
      // is pinned.
      for (const entry of READS_CLOSED_TODAY)
        it(`refuses ${entry.name}`, async () => {
          const { status, code } = entry.refusal ?? HIDDEN;
          expectProblem(await read(entry), status, code);
        });

      describe('and something tries to change a workflow', () => {
        let before: unknown;

        beforeAll(async () => {
          before = (
            await api
              .database()
              .query(durableWorkspaceFacts, [world.workspaceId])
          ).rows[0];
        });

        for (const write of AUTHORING_WRITES)
          it(`refuses ${write.name}`, async () => {
            expectProblem(await sendWrite(write), 404, 'resource.not_found');
          });

        it('has changed nothing after all of those', async () => {
          const after = await api
            .database()
            .query(durableWorkspaceFacts, [world.workspaceId]);
          expect(after.rows[0]).toEqual(before);
        });
      });
    });

    describe('while it is being purged', () => {
      beforeAll(() => enter('purging'));
      it('refuses retained export after browsing closes', async () => {
        const refused = await api.send(
          'POST',
          `/v1/workspaces/${world.workspaceId}/workflows/${world.workflowId}/export`,
          {
            browser: owner,
            headers: apiHeaders(),
            payload: {
              source: { kind: 'version', versionId: world.versionId },
              reviewedGraphDigest:
                await portableGraphDigest(emptyWorkflowGraph()),
            },
          },
        );
        expectProblem(refused, 404, 'resource.not_found');
      });

      for (const entry of [...READS_OPEN_TODAY, ...READS_CLOSED_TODAY])
        it(`refuses ${entry.name}`, async () => {
          const { status, code } = entry.refusal ?? HIDDEN;
          expectProblem(await read(entry), status, code);
        });
    });

    describe('after a real delete and restore', () => {
      it('lists the workflows that were there', async () => {
        const email = `restored-${crypto.randomUUID()}@example.test`;
        await api.signUp(email, '/workspaces');
        const first = await api.signIn(email);
        const workspace = await api.send('POST', '/v1/workspaces', {
          browser: first,
          headers: apiHeaders(),
          payload: {
            name: 'Restored',
            slug: `restored-${crypto.randomUUID().slice(0, 12)}`,
          },
        });
        expect(workspace.statusCode, workspace.payload).toBe(201);
        const root = `/v1/workspaces/${workspace.json<{ id: string }>().id}`;
        const made = await api.send('POST', `${root}/workflows`, {
          browser: first,
          headers: apiHeaders(),
          payload: { name: 'Kept' },
        });
        expect(made.statusCode, made.payload).toBe(201);
        const saved = await api.send(
          'PUT',
          `${root}/workflows/${made.json<{ workflow: { id: string } }>().workflow.id}/draft`,
          {
            browser: first,
            headers: apiHeaders({ 'if-match': String(made.headers.etag) }),
            payload: { graph: emptyWorkflowGraph() },
          },
        );
        expect(saved.statusCode, saved.payload).toBe(200);
        const deletion = await api.send('POST', `${root}/deletion`, {
          browser: first,
          headers: apiHeaders(),
          payload: { reason: 'restore proof' },
        });
        expect(deletion.statusCode, deletion.payload).toBe(200);
        const restored = await api.send('DELETE', `${root}/deletion`, {
          browser: await api.signIn(email),
          headers: apiHeaders(),
        });
        expect(restored.statusCode, restored.payload).toBe(200);

        const listed = await api.send('GET', `${root}/workflows`, {
          browser: await api.signIn(email),
        });
        expect(listed.statusCode, listed.payload).toBe(200);
        expect(
          listed.json<{ items: readonly { name: string }[] }>().items,
        ).toMatchObject([{ name: 'Kept' }]);
      });
    });
  },
);
