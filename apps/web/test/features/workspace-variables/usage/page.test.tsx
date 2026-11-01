import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../support/fixtures/identity';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
import { reference, removeOff, serveUsage, usagePage } from './check.support';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const timestamp = '2026-10-19T10:00:00.000Z';

it('takes a manager from Remove through the finished check to a name gone from the draft', async () => {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () =>
      HttpResponse.json(
        createUserFixture({
          id: userId,
          email: 'owner@example.test',
          displayName: 'Workspace Owner',
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
    ),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            name: 'Automation workspace',
            slug: 'automation',
            capabilities: ['workspace:read', 'variable:manage'],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        nextCursor: null,
      }),
    ),
    http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/variables`, () =>
      HttpResponse.json({
        revision: 4,
        values: { CURRENCY: 'EUR', RATE: 10 },
        descriptions: {},
      }),
    ),
  );
  serveUsage({
    first: [usagePage({ checked: 1, total: 2 }, { next: 'c1' })],
    c1: [
      usagePage(
        { checked: 2, total: 2 },
        { items: [reference('Invoice export')] },
      ),
    ],
  });
  renderApp(`/w/${workspaceId}/settings/variables`);
  const event = userEvent.setup();

  const row = await screen.findByRole(
    'region',
    { name: 'RATE' },
    { timeout: 15_000 },
  );
  await event.click(
    within(row).getByRole('button', { name: 'More actions for RATE' }),
  );
  await event.click(await screen.findByRole('menuitem', { name: 'Remove' }));

  expect(
    await screen.findByText('Checked all 2 workflows you can see.'),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: 'Invoice export' })).toBeVisible();

  await event.click(removeOff());
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'RATE' })).toBeNull();
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('region', { name: 'CURRENCY' })).toBeVisible();
});
