import { workflowOrganizationKeys } from '@/features/workflows/data/organization/queries';
import { ApiError } from '@/lib/api/error';
import { workflowSummarySchema } from '@pertexo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { summary, userId, workflowId, workspaceId } from '../../list/fixtures';
import { Probe } from './probe';
import { folderId, tagId } from './records';
export const folders = {
  items: [
    {
      id: folderId,
      name: 'Private folder',
      revision: 1,
      parentId: null,
      depth: 1,
    },
  ],
};

export const tags = {
  items: [{ id: tagId, key: 'private-tag', revision: 1 }],
  nextCursor: null,
};

export const page = {
  items: [
    {
      workflow: workflowSummarySchema.parse(
        summary(workflowId, 'Protected workflow'),
      ),
      organization: {
        folderId,
        tags: tags.items,
        organizationRevision: 1,
        isFavorite: true,
      },
    },
  ],
  nextCursor: null,
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function denied(status: number) {
  return new ApiError({ kind: 'problem', status, message: 'private body' });
}

export function setup(
  actor = userId,
  tenant = workspaceId,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  }),
) {
  const view = render(
    <QueryClientProvider client={client}>
      <Probe actor={actor} tenant={tenant} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    rerenderScope: (nextActor: string, nextTenant: string) => {
      view.rerender(
        <QueryClientProvider client={client}>
          <Probe actor={nextActor} tenant={nextTenant} />
        </QueryClientProvider>,
      );
    },
  };
}

export async function ready() {
  await screen.findByText('Protected workflow Private favorite');
  if (
    screen
      .getByRole('button', { name: /^Filters/u })
      .getAttribute('aria-expanded') !== 'true'
  )
    await userEvent.click(screen.getByRole('button', { name: /^Filters/u }));
  await screen.findByText('Private folder');
  await screen.findByText('private-tag');
}

export async function forgotten(client: QueryClient) {
  await waitFor(() => {
    expect(
      screen.queryByText('Protected workflow Private favorite'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Private folder')).not.toBeInTheDocument();
    expect(screen.queryByText('private-tag')).not.toBeInTheDocument();
    const scoped = client.getQueryCache().findAll({
      queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
    });
    expect(scoped.every((query) => query.state.data === undefined)).toBe(true);
  });
}
