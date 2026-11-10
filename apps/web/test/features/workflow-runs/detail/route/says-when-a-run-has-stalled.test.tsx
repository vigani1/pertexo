import { screen } from '@testing-library/react';

import { describe, expect, it } from 'vitest';

import { coldStart, fixtureRun } from '../../../../support/fixtures/run';

import { renderLoadedApp } from '../../../../support/render-app';

import { installRun, node, runId, secondsAgo, workspaceId } from './fixture';

const runPage = `/w/${workspaceId}/runs/${runId}`;
const STALLED_WORDING = /stalled/iu;

describe('run page', () => {
  // reliability-10: a stuck run reads "Running", as if its steps were progressing.
  it('says when a running run has stalled', async () => {
    installRun({
      run: fixtureRun(runId, 'running', {
        stalled: { since: secondsAgo(90) },
      }),
      nodes: [node('running')],
    });
    await renderLoadedApp(runPage);
    expect(
      await screen.findByText(STALLED_WORDING, {}, coldStart),
    ).toBeVisible();
  });

  it('says nothing of the kind about a healthy running run', async () => {
    installRun({
      run: fixtureRun(runId, 'running'),
      nodes: [node('running')],
    });
    await renderLoadedApp(runPage);
    await screen.findAllByText('Running', {}, coldStart);
    expect(screen.queryByText(STALLED_WORDING)).toBeNull();
  });
});
