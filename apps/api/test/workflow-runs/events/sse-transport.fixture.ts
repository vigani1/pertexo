export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export function frame(id: number) {
  return {
    id,
    event: 'run.started',
    data: JSON.stringify({
      sequence: id,
      type: 'run.started',
      createdAt: '2026-08-21T12:00:00.000Z',
      payload: {},
    }),
    visibilityPath: 'initial_backfill' as const,
  };
}

export function nestedAggregateErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return [
    error,
    ...error.errors.flatMap((nested: unknown) => nestedAggregateErrors(nested)),
  ];
}
