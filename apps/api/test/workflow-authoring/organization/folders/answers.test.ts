import { afterEach, describe, expect, it } from 'vitest';

import {
  actorId,
  cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture,
  folderId,
  routes,
  setup,
} from '../batch/batch-http.fixture.js';

const folderRoutes = routes.filter((route) => route.port !== 'admitBatch');
const folderReceipts = folderRoutes.filter((route) =>
  ['create', 'rename', 'move'].includes(route.method),
);

afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);

describe('folder answers over HTTP', () => {
  it.each(folderRoutes)(
    'answers $method without fields the route does not declare',
    async (route) => {
      const f = await setup();
      const expected = (await f.inject(route)).json<unknown>();
      const result: unknown = await f.port(route).mock.results[0]?.value;
      f.port(route).mockResolvedValueOnce({
        ...(result as object),
        actorId,
        body: { name: 'private' },
        pauseRevision: '42',
      });
      const reply = await f.inject(route);
      expect(reply.statusCode).toBe(route.status);
      expect(reply.json()).toEqual(expected);
      expect(reply.body).not.toContain('private');
    },
  );

  it.each(folderRoutes)(
    'fails $method with a server error when core answers nothing usable',
    async (route) => {
      const f = await setup();
      f.port(route).mockResolvedValueOnce({});
      expect((await f.inject(route)).statusCode).toBe(500);
    },
  );

  it.each(folderReceipts)(
    'fails $method rather than answer a folder whose nesting contradicts itself',
    async (route) => {
      const f = await setup();
      f.port(route).mockResolvedValueOnce({
        folder: {
          id: folderId,
          name: 'Operations',
          revision: 2,
          depth: 2,
          parentId: null,
        },
        replayed: true,
      });
      expect((await f.inject(route)).statusCode).toBe(500);
    },
  );
});
