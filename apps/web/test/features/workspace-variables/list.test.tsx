import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../support/fixtures/identity';
import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const timestamp = '2026-10-19T10:00:00.000Z';
const endpoint = `http://pertexo.test/v1/workspaces/${workspaceId}/variables`;

const values = {
  BASE_URL: 'https://api.example.test',
  CURRENCY: 'EUR',
  MAX_ITEMS: 50,
  REGION_EU_ENDPOINT: 'https://eu.example.test',
  REGION_US_ENDPOINT: 'https://us.example.test',
  SEND_RECEIPTS: true,
  SUPPORT_EMAIL: 'help@example.test',
};

function fixtures() {
  const writes: unknown[] = [];
  let revision = 4;
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
    http.get(endpoint, () =>
      HttpResponse.json({
        revision,
        values,
        descriptions: { CURRENCY: 'Invoice currency.' },
      }),
    ),
    http.put(endpoint, async ({ request }) => {
      writes.push(await request.json());
      revision += 1;
      return HttpResponse.json({ revision, changed: true, replayed: false });
    }),
  );
  return writes;
}

const rowNames = () =>
  within(screen.getByRole('group', { name: 'Workspace variables' }))
    .getAllByRole('region')
    .map((row) => row.getAttribute('aria-label'));

describe('workspace variables list', () => {
  it(
    'states the limits and what a replay keeps',
    { timeout: 30_000 },
    async () => {
      fixtures();
      renderApp(`/w/${workspaceId}/settings/variables`);
      const event = userEvent.setup();
      await event.click(
        await screen.findByText('Limits', {}, { timeout: 15_000 }),
      );
      expect(
        screen.getByText(
          'Up to 100 names, 4,096 characters per text value and 32 KB in all. A replay, a recovery or a child workflow keeps the values its run started with.',
        ),
      ).toBeVisible();
    },
  );

  it('shows one line per variable and filters by name, value or description', async () => {
    fixtures();
    renderApp(`/w/${workspaceId}/settings/variables`);
    const event = userEvent.setup();
    const currency = await screen.findByRole('region', { name: 'CURRENCY' });
    expect(within(currency).getByText('Invoice currency.')).toBeVisible();
    expect(within(currency).getByText('EUR')).toBeVisible();
    // Summaries hold no fields until a row is opened.
    expect(within(currency).queryByLabelText('Value')).toBeNull();

    await event.type(screen.getByLabelText('Filter variables'), 'region');
    expect(rowNames()).toEqual(['REGION_EU_ENDPOINT', 'REGION_US_ENDPOINT']);
    await event.clear(screen.getByLabelText('Filter variables'));
    await event.type(screen.getByLabelText('Filter variables'), 'invoice');
    expect(rowNames()).toEqual(['CURRENCY']);
    await event.clear(screen.getByLabelText('Filter variables'));
    await event.type(screen.getByLabelText('Filter variables'), 'nothing');
    expect(screen.getByText('No variables match “nothing”.')).toBeVisible();
  });

  it('edits a row in place, marks it unsaved and closes it once saved', async () => {
    const writes = fixtures();
    renderApp(`/w/${workspaceId}/settings/variables`);
    const event = userEvent.setup();
    const max = await screen.findByRole('region', { name: 'MAX_ITEMS' });
    await event.click(
      within(max).getByRole('button', { name: 'Edit MAX_ITEMS' }),
    );
    const value = within(max).getByLabelText('Value');
    await event.clear(value);
    await event.type(value, '75');
    await event.click(within(max).getByRole('button', { name: 'Done' }));
    expect(within(max).getByText('Unsaved')).toBeVisible();
    expect(within(max).getByText('75')).toBeVisible();

    await event.click(screen.getByRole('button', { name: 'Save variables' }));
    await waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    expect(writes[0]).toMatchObject({
      expectedRevision: 4,
      values: { ...values, MAX_ITEMS: 75 },
    });
    await waitFor(() => {
      expect(within(max).queryByText('Unsaved')).toBeNull();
    });
  });

  it('opens a new variable ready to fill in', async () => {
    fixtures();
    renderApp(`/w/${workspaceId}/settings/variables`);
    const event = userEvent.setup();
    await screen.findByRole('region', { name: 'CURRENCY' });
    await event.click(screen.getByRole('button', { name: 'Add variable' }));
    const added = screen.getByRole('region', { name: 'New variable' });
    expect(within(added).getByLabelText('Name')).toBeVisible();
  });
});
