import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/error';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function failRead(key: readonly unknown[], error: Error) {
  const queryClient = new QueryClient();
  const denied = vi.fn();
  const stop = watchWorkspaceReadDenial({
    queryClient,
    userId,
    workspaceId,
    counts: () => true,
    denied,
  });
  await queryClient
    .query({
      queryKey: key,
      queryFn: () => Promise.reject(error),
      retry: false,
    })
    .catch(() => undefined);
  stop();
  return denied;
}

const scoped = ['identity', userId, 'workspace', workspaceId, 'workflows'];
const problem = (status: number) =>
  new ApiError({ kind: 'problem', message: 'refused', status });

// A read that loses access (signed out, forbidden or gone) ends the
// feature's access; any other failure leaves it alone.
it.each([401, 403, 404])(
  'ends access when a workspace read answers %i',
  async (status) => {
    expect(await failRead(scoped, problem(status))).toHaveBeenCalledOnce();
  },
);

it.each([
  ['a 409', problem(409)],
  ['a 500', problem(500)],
  ['a lost connection', new ApiError({ kind: 'network', message: 'lost' })],
])('keeps access after %s', async (_name, error) => {
  expect(await failRead(scoped, error)).not.toHaveBeenCalled();
});

it('ignores denied reads of another workspace', async () => {
  const other = ['identity', userId, 'workspace', 'other', 'workflows'];
  expect(await failRead(other, problem(403))).not.toHaveBeenCalled();
});
