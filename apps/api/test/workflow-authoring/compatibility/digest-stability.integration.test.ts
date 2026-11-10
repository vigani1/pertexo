import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createWorkflowLifecycleApiFixture,
  closeWorkflowLifecycleApiFixture,
  mutationHeaders,
  workflowLifecycleIntegrationEnabled,
  type WorkflowLifecycleApiFixture,
} from '../lifecycle.support.js';

let fixture: WorkflowLifecycleApiFixture;
beforeAll(async () => {
  if (workflowLifecycleIntegrationEnabled)
    fixture = await createWorkflowLifecycleApiFixture();
});
afterAll(async () => {
  if (workflowLifecycleIntegrationEnabled)
    await closeWorkflowLifecycleApiFixture(fixture);
});

it.skipIf(!workflowLifecycleIntegrationEnabled)(
  'keeps reviewed content identity across metadata edits and changes it after a graph edit',
  async () => {
    const session = await fixture.login('owner');
    const base = `/v1/workspaces/${fixture.workspaceId}`;
    const workflow = `${base}/workflows/${fixture.ids.published}`;
    const get = (path: string) =>
      fixture.application.inject({
        method: 'GET',
        url: path,
        headers: { cookie: session.cookieHeader },
      });
    const read = async () => {
      const draft = await get(`${workflow}/draft?include=graphDigest`);
      const versions = await get(`${workflow}/versions?include=graphDigest`);
      expect(draft.statusCode, draft.payload).toBe(200);
      expect(versions.statusCode, versions.payload).toBe(200);
      return {
        draft,
        digest: draft.json<{ graphDigest: string }>().graphDigest,
        versions: versions.json<unknown>(),
      };
    };
    const initial = await read();
    expect(initial.digest).toMatch(/^.*[0-9a-f]{64}$/u);
    const renamed = await fixture.application.inject({
      method: 'POST',
      url: `${workflow}/rename`,
      headers: mutationHeaders(session, { 'idempotency-key': randomUUID() }),
      payload: { name: 'Metadata rename', expectedNameRevision: 1 },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect((await read()).digest).toBe(initial.digest);
    const folder = await fixture.application.inject({
      method: 'POST',
      url: `${base}/workflow-folders`,
      headers: mutationHeaders(session, { 'idempotency-key': randomUUID() }),
      payload: { name: 'Metadata folder', parentId: null },
    });
    expect(folder.statusCode, folder.payload).toBe(201);
    const placed = await fixture.application.inject({
      method: 'POST',
      url: `${workflow}/folder`,
      headers: mutationHeaders(session, { 'idempotency-key': randomUUID() }),
      payload: {
        folderId: folder.json<{ folder: { id: string } }>().folder.id,
        expectedOrganizationRevision: 1,
      },
    });
    expect(placed.statusCode, placed.payload).toBe(200);
    expect((await read()).digest).toBe(initial.digest);
    const favorite = await fixture.application.inject({
      method: 'PUT',
      url: `${workflow}/favorite`,
      headers: mutationHeaders(session),
      payload: { favorite: true },
    });
    expect(favorite.statusCode, favorite.payload).toBe(200);
    const metadata = await read();
    expect(metadata.digest).toBe(initial.digest);
    expect(metadata.versions).toEqual(initial.versions);
    const graph = metadata.draft.json<{
      graph: { nodes: object[]; edges: object[]; settings: object };
    }>().graph;
    const changed = await fixture.application.inject({
      method: 'PUT',
      url: `${workflow}/draft`,
      headers: mutationHeaders(session, {
        'if-match': String(metadata.draft.headers.etag),
      }),
      payload: {
        graph: {
          ...graph,
          nodes: [
            {
              id: 'new-step',
              definition: { key: 'core.set', version: 1 },
              configVersion: 1,
              config: {},
              inputMappings: {},
              connectionRefs: {},
              position: { x: 0, y: 0 },
            },
          ],
        },
      },
    });
    expect(changed.statusCode, changed.payload).toBe(200);
    const edited = await read();
    expect(edited.digest).not.toBe(initial.digest);
    expect(edited.versions).toEqual(initial.versions);
    expect((await read()).digest).toBe(edited.digest);
  },
);
