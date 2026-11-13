import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useLowEffectMutation } from '@/lib/api/commands/low-effect-mutation';
import { ApiError } from '@/lib/api/error';

// A change that sets an absolute state with no revision (alerts on or off,
// a schedule on or off). After its answer is lost, only a read that
// answered after that outcome may say the change isn't there and let a
// repeat apply under a new key. Any older read proves nothing, so the
// repeat must replay the first key: the server then applies it once.
const read = ['switch-state'] as const;
type State = Readonly<{ on: boolean }>;
type Input = Readonly<{ on: boolean }>;

const lost = () =>
  new ApiError({ kind: 'network', message: 'The answer was lost' });

function setup(refresh: (client: QueryClient) => Promise<unknown>) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const keys: string[] = [];
  let answer: (key: string) => Promise<string> = () => Promise.reject(lost());
  const { result } = renderHook(
    () =>
      useLowEffectMutation<Input, string, State>({
        send: (_input, key) => {
          keys.push(key);
          return answer(key);
        },
        refresh: () => refresh(client),
        appliedIn: { read, shows: (data, input) => data.on === input.on },
      }),
    {
      wrapper: ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return {
    client,
    keys,
    answerWith: (next: typeof answer) => {
      answer = next;
    },
    send: (input: Input) =>
      act(async () => {
        await result.current.mutateAsync(input).catch(() => undefined);
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it('replays the first key when the only read that disagrees answered before the outcome', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  // The refresh after the lost answer fails, so it adds no newer read.
  const page = setup(() => Promise.reject(new Error('read failed')));
  page.client.setQueryData(read, { on: true });
  page.answerWith(() => {
    // A read answers while the change is on its way, before the server
    // applied it, then the change lands and its answer is lost.
    vi.setSystemTime(1_000_050);
    page.client.setQueryData(read, { on: true });
    vi.setSystemTime(1_000_100);
    return Promise.reject(lost());
  });
  await page.send({ on: false });
  page.answerWith(() => Promise.resolve('replayed'));
  await page.send({ on: false });
  expect(page.keys).toHaveLength(2);
  expect(page.keys[1]).toBe(page.keys[0]);
});

it('replays the first key when the read is on no screen and never refetched', async () => {
  // Nothing observes the read, so invalidating it marks it stale and
  // fetches nothing: its data is from before the change.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  const page = setup((client) => client.invalidateQueries({ queryKey: read }));
  page.client.setQueryData(read, { on: true });
  vi.setSystemTime(1_060_000);
  await page.send({ on: false });
  page.answerWith(() => Promise.resolve('replayed'));
  await page.send({ on: false });
  expect(page.keys).toHaveLength(2);
  expect(page.keys[1]).toBe(page.keys[0]);
});

it('takes a new key once a read that answered after the outcome shows the change undone', async () => {
  // The control: a fresh read showing the old state lets the repeat apply.
  const page = setup((client) => {
    client.setQueryData(read, { on: true });
    return Promise.resolve();
  });
  page.client.setQueryData(read, { on: true });
  await page.send({ on: false });
  page.answerWith(() => Promise.resolve('applied'));
  await page.send({ on: false });
  expect(page.keys).toHaveLength(2);
  expect(page.keys[1]).not.toBe(page.keys[0]);
});
