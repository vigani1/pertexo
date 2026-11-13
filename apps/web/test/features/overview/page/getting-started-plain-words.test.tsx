import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { fixtureRun } from '../../../support/fixtures/run';
import { coldStart, identityHandlers } from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  installRun,
  node,
  runId,
} from '../../workflow-runs/detail/route/fixture';
import {
  readerCapabilities,
  runHandlers,
  workflow,
  workflowHandlers,
  workspaceId,
} from './fixture';

const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;

/** Words that name the system's insides rather than what a person sees. */
const INTERNAL = [
  /\bloom\b/iu,
  /\bweft\b/iu,
  /\bthreads?\b/iu,
  /\bnodes?\b/iu,
  /\bcheckpoints?\b/iu,
  /\bleases?\b/iu,
  /\binvocations?\b/iu,
  /\bexecution budget\b/iu,
  /\bactive slot\b/iu,
  /\b[a-z]+_[a-z_]+\b/u,
];

function internalWords(text: string) {
  return INTERNAL.flatMap((word) => text.match(word) ?? []);
}

function newWorkspace() {
  mockServer.use(
    ...identityHandlers([
      ...readerCapabilities,
      'workflow:create',
      'connection:read',
    ]),
    workflowHandlers([]),
    ...runHandlers({ problems: [], any: [] }),
    http.get(`${api}/connections`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

function afterFirstRun() {
  mockServer.use(
    ...identityHandlers([...readerCapabilities, 'connection:read']),
    workflowHandlers([workflow({ publishedVersionId: crypto.randomUUID() })]),
    ...runHandlers(),
    http.get(`${api}/connections`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

describe('Getting started and the timeline in plain words', () => {
  it.each([
    ['a new workspace', newWorkspace, '0 of 4 done.'],
    ['after the first run', afterFirstRun, '3 of 4 done.'],
  ] as const)(
    'names no system insides on Home for %s, and every task is a link into the workspace',
    async (_when, install, progress) => {
      install();
      await renderLoadedApp(`/w/${workspaceId}`);
      const section = await screen.findByRole(
        'region',
        { name: 'Getting started' },
        coldStart,
      );
      await within(section).findByText(progress, { exact: false });
      expect(internalWords(document.body.textContent)).toEqual([]);

      const tasks = within(section).getAllByRole('listitem');
      expect(tasks).toHaveLength(4);
      for (const task of tasks) {
        const links = within(task).getAllByRole('link');
        expect(links).toHaveLength(1);
        expect(links[0]?.getAttribute('href')).toMatch(
          new RegExp(`^/w/${workspaceId}/`, 'u'),
        );
      }
    },
  );

  it('opens a task’s page when it is followed', async () => {
    newWorkspace();
    const { router } = await renderLoadedApp(`/w/${workspaceId}`);
    const section = await screen.findByRole(
      'region',
      { name: 'Getting started' },
      coldStart,
    );
    await userEvent
      .setup()
      .click(within(section).getByRole('link', { name: 'Create a workflow' }));
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/workflows`);
    expect(router.state.location.search).toEqual({ create: true });
  });

  it('names no system insides on a run’s timeline', async () => {
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes: [node('succeeded')],
    });
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole('tab', { name: /^Timeline/u, selected: true }),
    ).toBeVisible();
    const timeline = await screen.findByRole('tabpanel');
    expect(timeline.textContent).not.toBe('');
    expect(internalWords(document.body.textContent)).toEqual([]);
  });
});
