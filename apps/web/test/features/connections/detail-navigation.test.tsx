import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  base,
  connection,
  connectionId,
  detailOf,
  identityHandlers,
  lens,
  listOf,
  userId,
  workspace,
  workspaceId,
} from './page/fixture';

it('reports when searchable usage is partial and finds later workflows after loading them', async () => {
  const current = connection('Primary Slack');
  const usage = (workflowName: string) => ({
    workflowId: crypto.randomUUID(),
    workflowName,
    workflowLifecycleStatus: 'active',
    workflowVersionId: crypto.randomUUID(),
    versionNumber: 1,
    isCurrentPublication: true,
    operationKeys: ['slack.send_message'],
  });
  const earlier = Array.from({ length: 6 }, (_, i) =>
    usage(`Workflow ${String(i + 1)}`),
  );
  const later = usage('Later workflow');
  mockServer.use(
    ...identityHandlers(workspace, false),
    listOf(() => [current]),
    detailOf(() => current),
    http.get(`${base}/${connectionId}/usage`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.has('after')
          ? { items: [later], nextCursor: null }
          : { items: earlier, nextCursor: 'older-page' },
      ),
    ),
  );
  await renderLoadedApp(
    `/w/${workspaceId}/connections?connection=${connectionId}`,
  );
  expect(
    await screen.findByRole('heading', { name: '6 workflows loaded' }),
  ).toBeVisible();
  await userEvent.type(
    screen.getByRole('searchbox', { name: /Find a workflow or step/u }),
    'Later workflow',
  );
  expect(screen.getByText(/No loaded workflow or step matches/u)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(
    await screen.findByRole('heading', { name: 'All 7 workflows' }),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: later.workflowName })).toBeVisible();
});

it('keeps an uncertain sharing save available when another connection is selected', async () => {
  const first = connection('Primary Slack');
  const second = connection('Secondary Slack', {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  });
  const ids: (string | null)[] = [];
  const sharing = {
    connectionId,
    revision: 1,
    mode: 'workspace',
    members: [],
  };
  const url = `${base}/${connectionId}/sharing`;
  mockServer.use(
    ...identityHandlers(),
    listOf(() => [first, second]),
    detailOf(() => first),
    http.get(`${base}/${second.id}`, () => HttpResponse.json(second)),
    http.get(`${base}/${second.id}/usage`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${base}/${second.id}/sharing`, () =>
      HttpResponse.json({ ...sharing, connectionId: second.id }),
    ),
    http.get(url, () => HttpResponse.json(sharing)),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/resource-sharing-principals`,
      () =>
        HttpResponse.json({
          items: [
            {
              kind: 'member',
              userId,
              label: 'Jane',
              email: 'jane@example.test',
              role: 'builder',
            },
          ],
          nextCursor: null,
        }),
    ),
    http.post(url, ({ request }) => {
      ids.push(request.headers.get('idempotency-key'));
      return ids.length === 1
        ? HttpResponse.error()
        : HttpResponse.json({
            connectionId,
            revision: 2,
            mode: 'restricted',
            members: [{ userId, label: 'Jane', active: true }],
            replayed: true,
          });
    }),
  );
  await renderLoadedApp(
    `/w/${workspaceId}/connections?connection=${connectionId}`,
  );
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: /^Share$/u }));
  await actor.click(
    await lens().findByText('Only people you choose', { exact: true }),
  );
  await actor.click(await lens().findByRole('button', { name: 'Add Jane' }));
  await actor.click(lens().getByRole('button', { name: /^Save$/u }));
  const retry = await lens().findByRole('button', { name: 'Try again' });
  await actor.click(screen.getByRole('button', { name: /^Secondary Slack,/u }));
  expect(screen.getByRole('article', { name: 'Primary Slack' })).toBeVisible();
  expect(retry).toBeVisible();
  await actor.click(retry);
  await waitFor(() => {
    expect(ids).toEqual([expect.any(String), ids[0]]);
  });
});
