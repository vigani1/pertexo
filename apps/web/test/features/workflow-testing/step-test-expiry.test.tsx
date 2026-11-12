import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { panel } from './node-preview-lifecycle/fixture';

afterEach(() => vi.restoreAllMocks());
it('requires fresh effects consent after a step test retry expires', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const keys: (string | null)[] = [];
  mockServer.use(
    http.get(
      'http://pertexo.test/v1/workspaces/:workspace/workflows/:workflow/draft/samples',
      () =>
        HttpResponse.json({
          items: [],
          draftRevision: 1,
          limits: { inlineBytes: 262144, depth: 64, members: 10000 },
        }),
    ),
    http.post(
      'http://pertexo.test/v1/workspaces/:workspace/workflows/:workflow/draft/nodes/:node/test',
      ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return HttpResponse.error();
      },
    ),
  );
  render(
    panel({
      apiClient: createApiClient({
        fetch: testFetch,
        readCsrfToken: () => 'csrf-token-1234567890',
      }),
      nodeId: 'node-a',
      stepSideEffect: 'external',
    }),
  );
  const user = userEvent.setup();
  const consent = await screen.findByRole('switch', {
    name: 'I understand this test runs for real',
  });
  await user.click(consent);
  const run = await screen.findByRole('button', { name: 'Run test' });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
  const retry = await screen.findByRole('button', {
    name: 'Retry the same test',
  });
  now += 86_400_000 - 1;
  await user.click(retry);
  await waitFor(() => {
    expect(keys).toHaveLength(2);
    expect(retry).toBeEnabled();
  });
  expect(keys[1]).toBe(keys[0]);
  now += 1;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const start = await screen.findByRole('button', {
    name: 'Start a new attempt',
  });
  expect(retry).toBeDisabled();
  expect(screen.getByText(/24-hour retry window has ended/)).toBeVisible();
  await user.click(retry);
  expect(keys).toHaveLength(2);
  now += 1;
  await user.click(retry);
  expect(keys).toHaveLength(2);
  await user.click(start);
  expect(keys).toHaveLength(2);
  expect(consent).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Run test' })).toBeDisabled();
  await user.click(consent);
  await user.click(screen.getByRole('button', { name: 'Run test' }));
  await waitFor(() => {
    expect(keys).toHaveLength(3);
  });
  expect(keys[0]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[0]);
});
