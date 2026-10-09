import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import { parseWorkflowListSearch } from '@/features/workflows/model/workflow-list-view';
import {
  api,
  discoveryHandlers,
  draftHandler,
  summary,
  workflowId,
  secondWorkflowId,
  workspaceId,
  userId,
} from './workflow-list.fixtures';
import { workflowOrganizationKeys } from '@/features/workflows/organization.queries';

vi.mock('@/features/workflows/model/organization-feature-gates', () => ({
  workflowOrganizationControlsEnabled: () => true,
}));
const folderId = '11111111-1111-4111-8111-111111111111';
const tagId = '22222222-2222-4222-8222-222222222222';
const organization = {
  organizationRevision: 1,
  folderId,
  tags: [{ id: tagId, key: 'ops', revision: 1 }],
  isFavorite: true,
};
function install(read: (url: URL) => Record<string, unknown>) {
  mockServer.use(
    ...discoveryHandlers(),
    draftHandler(),
    http.get(`${api}/workflow-folders`, () =>
      HttpResponse.json({
        items: [
          {
            id: folderId,
            name: 'Operations',
            parentId: null,
            revision: 1,
            depth: 1,
          },
        ],
      }),
    ),
    http.get(`${api}/workflow-tags`, () =>
      HttpResponse.json({ items: organization.tags, nextCursor: null }),
    ),
    http.get(`${api}/workflows`, ({ request }) =>
      HttpResponse.json(read(new URL(request.url))),
    ),
  );
}
function page(
  id = workflowId,
  name = 'Daily intake',
  nextCursor: string | null = null,
) {
  return { items: [{ workflow: summary(id, name), organization }], nextCursor };
}

describe('owned organization workflow list integration', () => {
  it('retires denied rows, tags and private favorites without opening a command dialog', async () => {
    install(() => page());
    const { queryClient } = renderApp(
      `/w/${workspaceId}/workflows?folderId=${folderId}&tagId=${tagId}`,
    );
    await screen.findByRole('link', { name: 'Daily intake' });
    await screen.findByText('Operations');
    mockServer.use(
      http.get(`${api}/workflows`, ({ request }) =>
        new URL(request.url).searchParams.get('include') === 'organization'
          ? HttpResponse.json({}, { status: 403 })
          : HttpResponse.json({
              items: [summary(workflowId, 'Daily intake')],
              nextCursor: null,
            }),
      ),
    );
    await queryClient.invalidateQueries({
      queryKey: [
        ...workflowOrganizationKeys.scope(userId, workspaceId),
        'list',
      ],
    });
    await screen.findByText('Workflows didn’t load');
    expect(
      screen.queryByRole('link', { name: 'Daily intake' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Remove favorite for Daily intake',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Filter by tag' }),
    ).toBeDisabled();
  });

  it('keeps an authorized organization snapshot with stale disclosure after503', async () => {
    install(() => page());
    const { queryClient } = renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByRole('link', { name: 'Daily intake' });
    mockServer.use(
      http.get(`${api}/workflows`, () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );
    await queryClient.invalidateQueries({
      queryKey: [
        ...workflowOrganizationKeys.scope(userId, workspaceId),
        'list',
      ],
    });
    expect(screen.getByRole('link', { name: 'Daily intake' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Remove favorite for Daily intake' }),
    ).toBeVisible();
    await screen.findByText(/couldn’t refresh/i);
  });
  it('binds all filters on the server and retains them through sort and view navigation', async () => {
    const reads: URL[] = [];
    install((url) => {
      reads.push(url);
      return page();
    });
    const { router } = renderApp(
      `/w/${workspaceId}/workflows?query=Ops&folderId=root&tagId=${tagId}&favoritesOnly=true&view=all`,
    );
    await screen.findByRole('link', { name: 'Daily intake' });
    const organizedRead = reads.find(
      (url) => url.searchParams.get('include') === 'organization',
    );
    expect(organizedRead).toBeDefined();
    for (const [key, value] of Object.entries({
      query: 'Ops',
      folderId: 'root',
      tagId,
      favoritesOnly: 'true',
      view: 'all',
    }))
      expect(organizedRead?.searchParams.get(key)).toBe(value);
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() => {
      expect(
        parseWorkflowListSearch(router.state.location.search),
      ).toMatchObject({
        view: 'archived',
        query: 'Ops',
        folderId: 'root',
        tagId,
        favoritesOnly: 'true',
      });
    });
    expect(
      screen.getByRole('searchbox', { name: 'Name contains' }),
    ).toHaveValue('Ops');
  });
  it('selects only explicit loaded rows, keeps pagination and clears selection at a new filter scope', async () => {
    const reads: URL[] = [];
    install((url) => {
      reads.push(url);
      return url.searchParams.has('after')
        ? page(secondWorkflowId, 'Second workflow')
        : page(workflowId, 'Daily intake', 'signed.next');
    });
    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('checkbox', { name: 'Select Daily intake' }),
    );
    expect(
      screen.getByRole('button', { name: 'Organize selected…' }),
    ).toBeEnabled();
    await event.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('checkbox', { name: 'Select Second workflow' });
    expect(
      screen.getByRole('checkbox', { name: 'Select Daily intake' }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Select Second workflow' }),
    ).not.toBeChecked();
    await event.click(screen.getByRole('button', { name: 'My favorites' }));
    await waitFor(() => {
      expect(reads.at(-1)?.searchParams.get('favoritesOnly')).toBe('true');
    });
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'Select Daily intake' }),
      ).not.toBeChecked(),
    );
    expect(
      screen.getByRole('button', { name: 'Organize selected…' }),
    ).toBeDisabled();
    expect(reads.at(-1)?.searchParams.has('after')).toBe(false);
  });
  it('searches literal names across unloaded pages and can clear filters from an empty result', async () => {
    const reads: URL[] = [];
    install((url) => {
      reads.push(url);
      return url.searchParams.has('query')
        ? { items: [], nextCursor: null }
        : page();
    });
    const { router } = renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await screen.findByRole('link', { name: 'Daily intake' });
    await event.type(
      screen.getByRole('searchbox', { name: 'Name contains' }),
      ' Ops%_ ',
    );
    await event.click(
      within(
        screen.getByRole('region', { name: 'Find and organize workflows' }),
      ).getByRole('button', { name: 'Search' }),
    );
    await screen.findByText('No workflows match these filters');
    expect(reads.at(-1)?.searchParams.get('query')).toBe('Ops%_');
    expect(router.state.location.search).toMatchObject({ query: 'Ops%_' });
    await event.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByRole('link', { name: 'Daily intake' });
    expect(
      screen.getByRole('searchbox', { name: 'Name contains' }),
    ).toHaveValue('');
  });
  it('keeps missing organization unavailable rather than rendering summary data as empty metadata', async () => {
    install(() => ({
      items: [summary(workflowId, 'Unsafe legacy response')],
      nextCursor: null,
    }));
    renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByText('Workflows didn’t load');
    expect(
      screen.queryByText('Unsafe legacy response'),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole('region', { name: 'Find and organize workflows' }),
      ).getByRole('button', { name: 'Clear filters' }),
    ).toBeVisible();
  });
});
