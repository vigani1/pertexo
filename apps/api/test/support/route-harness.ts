import type { DynamicModule } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { APPLICATION_ERROR_MAPPERS } from '../../src/application-errors.js';
import {
  ProblemDetailsFilter,
  RequestContextStore,
} from '../../src/platform/http/index.js';

/** The session FakeIdentityModule signs in, as an active owner of any workspace. */
export const HARNESS_ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const ownerAccess = {
  findAccess: ({ workspaceId }: Readonly<{ workspaceId: string }>) =>
    Promise.resolve({
      actorId: HARNESS_ACTOR_ID,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
};

type Send = Readonly<{
  query?: Readonly<Record<string, string>>;
  /** Sent as JSON; `json` instead sends text already written, such as one too deep to stringify. */
  body?: unknown;
  json?: string;
  headers?: Readonly<Record<string, string>>;
}>;

/**
 * A feature module behind real routing, guards, input parsing and the problem filter,
 * with a fake session, so a test sees what an HTTP caller would.
 */
export async function routeHarness(feature: DynamicModule) {
  const testing = await Test.createTestingModule({
    imports: [feature],
  }).compile();
  const adapter = new FastifyAdapter();
  const application = testing.createNestApplication(adapter);
  application.useGlobalFilters(
    new ProblemDetailsFilter(
      new RequestContextStore(),
      undefined,
      APPLICATION_ERROR_MAPPERS,
    ),
  );
  await application.init();
  await adapter.getInstance().ready();
  return {
    send: (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      input: Send = {},
    ) => {
      const payload =
        input.json ??
        (input.body === undefined ? undefined : JSON.stringify(input.body));
      return adapter.getInstance().inject({
        method,
        url,
        ...(input.query === undefined ? {} : { query: input.query }),
        headers: {
          cookie: 'pertexo_session=session-token',
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...input.headers,
        },
        ...(payload === undefined ? {} : { payload }),
      });
    },
    close: () => application.close(),
  };
}
