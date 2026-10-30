import { screen, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { coldStart } from '../../../../support/fixtures/run';
import { renderApp } from '../../../../support/render-app';
import { installRun, node, retryingRun, runId, workspaceId } from './fixture';

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

function problem(status: number, code: string, headers = {}) {
  return HttpResponse.json(
    {
      type: `urn:pertexo:problem:${code}`,
      title: 'Refused',
      status,
      code,
      requestId: 'stream-refused',
    },
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );
}

// Both live streams (runs and the inbox) stop when access is gone, and
// otherwise reconnect by themselves, after Retry-After when rate limited.
describe('run live updates', () => {
  it.each([
    [401, 'auth.unauthenticated'],
    [403, 'auth.forbidden'],
    [404, 'resource.not_found'],
  ] as const)(
    'stops for good when the stream answers %i',
    async (status, code) => {
      const run = installRun({
        run: retryingRun(),
        nodes: [node('running')],
        stream: () => problem(status, code),
      });
      renderApp(`/w/${workspaceId}/runs/${runId}`);
      expect(
        await screen.findByText('Updates paused', undefined, coldStart),
      ).toBeVisible();
      // A passing failure would have reconnected within about a second.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(run.streamCount()).toBe(1);
    },
  );

  it.each([
    ['a 503 gateway answer', () => new HttpResponse(null, { status: 503 })],
    [
      'a rate limit with Retry-After',
      () => problem(429, 'request.rate_limited', { 'retry-after': '1' }),
    ],
  ])('reconnects by itself after %s', async (_name, refusal) => {
    let answered = false;
    const run = installRun({
      run: retryingRun(),
      nodes: [node('running')],
      stream: () => {
        if (answered) return undefined;
        answered = true;
        return refusal();
      },
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    await waitFor(
      () => {
        expect(run.streamCount()).toBeGreaterThanOrEqual(2);
      },
      { timeout: 8_000 },
    );
  });
});
