import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { FirstRunGuide } from '@/features/workflows/first-run.public';
import { parseFirstRunGuideSearch } from '@/features/workflows/first-run-search.public';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { api, summary, userId, workflowId, workspaceId } from './list/fixtures';

function renderGuide(publishedVersionId: string | null) {
  mockServer.use(
    http.get(`${api}/workflows/${workflowId}`, () =>
      HttpResponse.json({
        workflow: summary(workflowId, 'Say hello', { publishedVersionId }),
      }),
    ),
  );
  const onDismiss = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FirstRunGuide
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () => 'csrf-token-for-component-tests-1234567890',
        })}
        userId={userId}
        workspaceId={workspaceId}
        workflowId={workflowId}
        onDismiss={onDismiss}
      />
    </QueryClientProvider>,
  );
  return onDismiss;
}

const step = (guide: HTMLElement, label: string) =>
  within(guide).getByText(label).closest('li');

describe('the guided first run in Build', () => {
  it('lights Publish first, then Run once the example is published', async () => {
    renderGuide(null);
    const guide = await screen.findByRole('region', { name: 'Your first run' });
    expect(step(guide, 'Publish it')).toHaveAttribute('aria-current', 'step');
    expect(step(guide, 'Publish it')).not.toHaveTextContent('Done');
  });

  it('marks Publish done and points at Run for a published example', async () => {
    renderGuide('12121212-1212-4121-8121-121212121212');
    const guide = await screen.findByRole('region', { name: 'Your first run' });
    expect(await within(guide).findByText('Done')).toBeVisible();
    expect(step(guide, 'Run it')).toHaveAttribute('aria-current', 'step');
  });

  it('hides when asked', async () => {
    const onDismiss = renderGuide(null);
    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Hide the first-run guide',
      }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('opens only for the guide Build was asked for', () => {
    expect(parseFirstRunGuideSearch({ guide: 'first-run' })).toEqual({
      guide: 'first-run',
    });
    expect(parseFirstRunGuideSearch({ guide: 'tour' })).toEqual({});
    expect(parseFirstRunGuideSearch({})).toEqual({});
  });
});
