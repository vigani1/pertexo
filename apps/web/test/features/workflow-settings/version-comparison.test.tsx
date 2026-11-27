import { HttpResponse, http } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { coldStart } from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  emptyGraph,
  installQueries,
  olderVersionId,
  problem,
  version,
  versionId,
  workflowApi,
  workflowId,
  workspaceId,
} from './fixtures';

const versionsPath = `/w/${workspaceId}/workflows/${workflowId}/versions`;

it('compares versions when the summary is unavailable', async () => {
  installQueries();
  mockServer.use(
    http.get(workflowApi, () => problem(503, 'internal.unexpected')),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [
          version(versionId, 2, emptyGraph),
          version(olderVersionId, 1, emptyGraph),
        ],
        nextCursor: null,
      }),
    ),
  );
  await renderLoadedApp(versionsPath);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Compare versions' }, coldStart),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Compare versions',
  });
  expect(dialog).toHaveTextContent('v1');
  expect(dialog).toHaveTextContent('v2');
});
