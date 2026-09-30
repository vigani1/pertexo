import type { ReactNode } from 'react';
import type { ScheduleStepConfig } from '@pertexo/contracts/schemas/schedules';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SchedulePreviewScope,
  useSchedulePreview,
} from '@/features/workflow-publish/schedule-preview.public';
import { createApiClient } from '@/lib/api/client';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const previewUrl = `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/schedules/preview`;
const daily: ScheduleStepConfig = {
  kind: 'cron',
  expression: '0 9 * * *',
  timezone: 'Europe/Paris',
};

type Sent = Readonly<{ url: string; body: unknown; csrf: string | null }>;

function server(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const request = new Request(
      typeof input === 'string' ? new URL(input, 'http://pertexo.test') : input,
      init,
    );
    return request.text().then((text) => {
      const entry = {
        url: request.url,
        body: JSON.parse(text) as unknown,
        csrf: request.headers.get('x-csrf-token'),
      };
      sent.push(entry);
      return respond(entry);
    });
  });
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <SchedulePreviewScope value={{ apiClient, workspaceId, workflowId }}>
      {children}
    </SchedulePreviewScope>
  );
  return { sent, wrapper };
}

function times(...scheduledAt: readonly string[]) {
  return Response.json({
    observedAt: '2026-09-25T08:00:00.000Z',
    items: scheduledAt.map((at) => ({ scheduledAt: at })),
  });
}

function problem(
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
) {
  return Response.json(
    { type: 'about:blank', title: 'Problem', status, code },
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );
}

async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('draft schedule preview', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-25T08:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the server once typing pauses, for the rule on screen only', async () => {
    const { sent, wrapper } = server(() =>
      times('2026-09-25T09:00:00.000Z', '2026-09-26T09:00:00.000Z'),
    );
    const { result, rerender } = renderHook(
      ({ config }: { config: ScheduleStepConfig | undefined }) =>
        useSchedulePreview(config),
      {
        wrapper,
        initialProps: { config: undefined as ScheduleStepConfig | undefined },
      },
    );
    expect(result.current).toEqual({ status: 'unavailable' });

    rerender({ config: { kind: 'interval', intervalMinutes: 5 } });
    await settle(200);
    rerender({ config: { kind: 'interval', intervalMinutes: 50 } });
    await settle(200);
    rerender({ config: daily });
    expect(result.current).toEqual({ status: 'loading' });
    await settle(499);
    expect(sent).toHaveLength(0);
    await settle(1);

    expect(sent).toEqual([
      {
        url: previewUrl,
        body: { config: daily, count: 3 },
        csrf: 'csrf-token-for-component-tests-12345678901234567890',
      },
    ]);
    expect(result.current).toEqual({
      status: 'ready',
      times: ['2026-09-25T09:00:00.000Z', '2026-09-26T09:00:00.000Z'],
    });

    // An unfinished rule sends nothing and shows nothing.
    rerender({ config: undefined });
    expect(result.current).toEqual({ status: 'unavailable' });
    await settle(1_000);
    expect(sent).toHaveLength(1);
  });

  it('asks again once the first run time has passed', async () => {
    let call = 0;
    const { sent, wrapper } = server(() => {
      call += 1;
      return call === 1
        ? times('2026-09-25T08:05:00.000Z', '2026-09-25T08:10:00.000Z')
        : times('2026-09-25T08:10:00.000Z', '2026-09-25T08:15:00.000Z');
    });
    const { result } = renderHook(
      () => useSchedulePreview({ kind: 'interval', intervalMinutes: 5 }),
      { wrapper },
    );
    await settle(500);
    expect(result.current).toMatchObject({
      times: ['2026-09-25T08:05:00.000Z', '2026-09-25T08:10:00.000Z'],
    });
    await settle(5 * 60_000 + 1_000);
    await settle(1_000);
    expect(sent).toHaveLength(2);
    expect(result.current).toMatchObject({
      times: ['2026-09-25T08:10:00.000Z', '2026-09-25T08:15:00.000Z'],
    });
  });

  it('says why a rule can’t be previewed and retries on request', async () => {
    let answer = problem(400, 'request.invalid');
    const { sent, wrapper } = server(() => answer);
    const { result } = renderHook(() => useSchedulePreview(daily), {
      wrapper,
    });
    await settle(500);
    expect(result.current).toMatchObject({
      status: 'failed',
      message:
        'Pertexo can’t schedule this rule. Check the cron fields and the timezone.',
    });

    answer = problem(429, 'request.rate_limited', { 'retry-after': '12' });
    act(() => {
      if (result.current.status === 'failed') result.current.retry();
    });
    expect(result.current).toEqual({ status: 'loading' });
    await settle(500);
    expect(result.current).toMatchObject({
      status: 'failed',
      message: 'Too many requests. Try again in 12 s.',
    });
    expect(sent).toHaveLength(2);
  });

  it('shows nothing where the editor can’t ask the server', () => {
    const { result } = renderHook(() => useSchedulePreview(daily));
    expect(result.current).toEqual({ status: 'unavailable' });
  });
});
