import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { coldStart } from '../../support/fixtures/run';
import {
  installQueries,
  workflowApi,
  problem,
  version,
  versionId,
  stepNode,
} from './fixtures';
import { triggersPath } from './triggers/fixture';

it('offers recovery for failed publication discovery without claiming there are no triggers', async () => {
  installQueries();
  let reads = 0;
  mockServer.use(
    http.get(`${workflowApi}/triggers`, () => HttpResponse.json({ items: [] })),
    http.get(`${workflowApi}/triggers/schedules`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${workflowApi}/versions`, () => {
      reads += 1;
      return problem(503, 'internal.unexpected');
    }),
  );
  await renderLoadedApp(triggersPath);
  const retry = await screen.findByRole('button', { name: 'Retry' }, coldStart);
  expect(
    screen.queryByText('This version has no trigger'),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Runs start only when someone runs the workflow/u),
  ).not.toBeInTheDocument();
  const previousReads = reads;
  await userEvent.setup().click(retry);
  await screen.findByRole('button', { name: 'Retry' });
  expect(reads).toBeGreaterThan(previousReads);
  expect(screen.getByRole('heading', { name: 'Schedules' })).toBeVisible();
});

it.each([
  [403, 'auth.forbidden'],
  [404, 'workflow.not_found'],
  [429, 'request.rate_limited'],
] as const)(
  'recovers Form discovery after a %s refusal without claiming trigger absence',
  async (status, code) => {
    installQueries();
    let refused = true;
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${workflowApi}/versions`, () =>
        refused
          ? problem(status, code)
          : HttpResponse.json({
              items: [
                version(versionId, 1, {
                  nodes: [stepNode('form', 'core.form')],
                  edges: [],
                  settings: {},
                }),
              ],
              nextCursor: null,
            }),
      ),
    );
    await renderLoadedApp(triggersPath);
    const retry = await screen.findByRole(
      'button',
      { name: 'Retry' },
      coldStart,
    );
    if (status !== 429) {
      expect(screen.getByText(/This isn’t available to you/u)).toBeVisible();
      expect(screen.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    }
    expect(
      screen.queryByText('This version has no trigger'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Runs start only when someone runs the workflow/u),
    ).not.toBeInTheDocument();
    refused = false;
    await userEvent.setup().click(retry);
    expect(await screen.findByRole('heading', { name: 'Form' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Build' })).toBeVisible();
    expect(
      screen.queryByText('This version has no trigger'),
    ).not.toBeInTheDocument();
  },
);
