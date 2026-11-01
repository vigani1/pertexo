import type { Pool, PoolClient, QueryResult } from 'pg';

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const actorId = '22222222-2222-4222-8222-222222222222';

export function result(
  rows: readonly Record<string, unknown>[] = [],
): QueryResult {
  return { rows } as unknown as QueryResult;
}

export function poolWith(
  client: Readonly<Record<'query' | 'release', unknown>>,
): Pool {
  return {
    connect: () => Promise.resolve(client as PoolClient),
  } as unknown as Pool;
}
