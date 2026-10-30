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
  expectShown,
  type Read,
} from './suspended/reads.js';
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
        // audit-1030 follow-up: read guards allow only `active` here (ADR 013/027).
        it.fails(`shows ${entry.name}`, async () => {
          expectShown(entry, await read(entry), world);
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

        for (const write of WRITES)
          it(`refuses ${write.name}`, async () => {
            const refused = await api.send(write.method, write.path(world), {
              browser: owner,
              headers: apiHeaders(write.headers?.(world)),
              ...(write.payload === undefined
                ? {}
                : { payload: write.payload(world) }),
            });
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

      // READS_OPEN_TODAY answer here too: their guards allow this state on
      // purpose or by habit, and nothing here decides which, so none is pinned.
      for (const entry of READS_CLOSED_TODAY)
        it(`refuses ${entry.name}`, async () => {
          const { status, code } = entry.refusal ?? HIDDEN;
          expectProblem(await read(entry), status, code);
        });
    });

    describe('while it is being purged', () => {
      beforeAll(() => enter('purging'));

      for (const entry of [...READS_OPEN_TODAY, ...READS_CLOSED_TODAY])
        it(`refuses ${entry.name}`, async () => {
          const { status, code } = entry.refusal ?? HIDDEN;
          expectProblem(await read(entry), status, code);
        });
    });

    describe('after a real delete and restore', () => {
      // audit-1030 follow-up: this is the 404 behind the banner's "look around".
      it.fails('lists the workflows that were there', async () => {
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
