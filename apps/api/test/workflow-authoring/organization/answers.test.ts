import { afterEach, describe, expect, it } from 'vitest';

import {
  actorId,
  cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture,
  headers,
  httpFixture,
  prefix,
  routes,
  tagId,
} from './organization-http.fixture.js';

type Fixture = Awaited<ReturnType<typeof httpFixture>>;

const commands = routes.filter((route) => route.body !== undefined);

function persistence(f: Fixture, name: (typeof commands)[number]['name']) {
  return name === 'favorite' ? f.favorites.setFavorite : f.tags[name];
}

function send(f: Fixture, route: (typeof commands)[number]) {
  return f.app.inject({
    method: route.method,
    url: prefix + route.suffix,
    headers,
    payload: route.body,
  });
}

afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);

describe('organization command answers over HTTP', () => {
  it.each(commands)(
    'answers $name without fields the route does not declare',
    async (route) => {
      const f = await httpFixture();
      const expected = (await send(f, route)).json<unknown>();
      const result: unknown = await persistence(f, route.name).mock.results[0]
        ?.value;
      persistence(f, route.name).mockResolvedValueOnce({
        ...(result as object),
        actorId,
        generation: tagId,
        proof: {},
      });
      const reply = await send(f, route);
      expect(reply.statusCode).toBe(route.status);
      expect(reply.json()).toEqual(expected);
      expect(reply.body).not.toContain('generation');
    },
  );

  it.each(commands)(
    'fails $name with a server error when core answers outside the route',
    async (route) => {
      const f = await httpFixture();
      persistence(f, route.name).mockResolvedValueOnce({ replayed: true });
      const reply = await send(f, route);
      expect(reply.statusCode).toBe(500);
      expect(reply.body).not.toContain('replayed');
    },
  );
});
