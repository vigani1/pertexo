import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  discoveryHandlers,
  summary,
  thirdWorkflowId,
  versionId,
  workspaceId,
} from './fixtures';
import { listHandler } from './page/fixture';

it('opens the complete preview and switches directly to draft workflows', async () => {
  mockServer.use(
    ...discoveryHandlers(),
    listHandler(() => ({
      items: [
        ...Array.from({ length: 6 }, (_, index) =>
          summary(
            `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            `Published workflow ${String(index + 1)}`,
            { publishedVersionId: versionId, activationStatus: 'active' },
          ),
        ),
        summary(thirdWorkflowId, 'Draft for review'),
      ],
      nextCursor: null,
    })),
  );
  await renderLoadedApp(`/w/${workspaceId}/workflows`);
  const list = await screen.findByRole('list', { name: 'Workflows' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  const actor = userEvent.setup();
  await actor.click(screen.getByRole('button', { name: 'Show all 7' }));
  expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  await actor.click(screen.getByRole('button', { name: /^Drafts$/u }));
  expect(
    (await screen.findAllByRole('listitem')).filter(
      (row) => row.closest('ul[aria-label="Workflows"]') !== null,
    ),
  ).toHaveLength(1);
  expect(
    within(screen.getByRole('list', { name: 'Workflows' })).getByRole('link', {
      name: 'Draft for review',
    }),
  ).toBeVisible();
});
