import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunsToolbar } from '@/features/workflow-runs/components/run-list/toolbar';
import { fixtureRun } from '../../support/fixtures/run';
import { renderLoadedApp } from '../../support/render-app';
import { installRun, node, runId, workspaceId } from './detail/route/fixture';

// product-ux-11: the names people act on are plain words, not Weft's.
describe('plain names for runs', () => {
  it('names the run page’s views Timeline and Diagram', async () => {
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes: [node('succeeded')],
    });
    await renderLoadedApp(`/w/${workspaceId}/runs/${runId}`);
    const tabs = await screen.findByRole('tablist');
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent.replace(/\d+$/u, '')),
    ).toEqual(['Timeline', 'Diagram', 'Events', 'Input & output']);
  });

  it('names the run list’s views List and Timeline', () => {
    render(
      <RunsToolbar
        live={false}
        onLiveChange={() => undefined}
        view="list"
        onViewChange={() => undefined}
      />,
    );
    const views = screen.getByRole('group', { name: 'View' });
    expect(
      within(views)
        .getAllByRole('button')
        .map((view) => view.textContent),
    ).toEqual(['List', 'Timeline']);
  });
});
