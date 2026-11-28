import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { coldStart, fixtureIds } from '../../support/fixtures/run';
import { renderLoadedApp } from '../../support/render-app';
import { capacity, install, path } from './page/fixture';

describe('workspace Usage', () => {
  it('says how much room is left, then runs per day and the busiest workflows', async () => {
    const { seen } = install();
    await renderLoadedApp(`${path}?period=90d&ignored=secret`);
    await screen.findByRole('heading', { name: 'Usage' }, coldStart);
    const room = screen.getByRole('region', { name: 'Room left' });
    expect(
      await within(room).findByText('8 PB', { selector: 'span' }),
    ).toBeVisible();
    expect(room).toHaveTextContent('8 EB');
    await userEvent.click(
      within(room).getByText('Capacity details', { selector: 'summary' }),
    );
    expect(room).toHaveTextContent(
      'One more place is held for a queued run about to start.',
    );
    expect(room).toHaveTextContent(
      'Right now 2 of 5 runs at once are going, with 4 queued behind them.',
    );
    expect(
      within(room).getByRole('img', { name: /% of file storage used$/u }),
    ).toBeVisible();
    const perDay = screen.getByRole('region', { name: 'Runs per day' });
    expect(
      await within(perDay).findByText(/^3 runs · \d+ failed$/u),
    ).toBeVisible();
    expect(perDay).toHaveTextContent('Over 90 UTC days.');
    expect(
      within(perDay).getByRole('img', { name: /Daily runs by outcome, UTC/u }),
    ).toBeVisible();
    expect(
      await within(
        screen.getByRole('region', { name: 'By workflow' }),
      ).findByText('Order intake'),
    ).toBeVisible();
    // The header shows the older of the two snapshot times.
    expect(document.querySelector('header time')).toHaveAttribute(
      'datetime',
      '2026-09-15T10:00:00.123456Z',
    );
    expect(seen.map((query) => query.get('period'))).toContain('90d');
  });

  it('writes counts in the thousands with separators', async () => {
    install({
      snapshot: {
        ...capacity,
        artifacts: { ...capacity.artifacts, chargedCount: 1250 },
      },
    });
    await renderLoadedApp(path);
    await userEvent.click(
      await screen.findByText(
        'Capacity details',
        { selector: 'summary' },
        coldStart,
      ),
    );
    expect(
      await screen.findByText(/^1,250 of 1,000 files/u, {}, coldStart),
    ).toBeVisible();
  });

  it('keeps the chosen range in the URL and reads that period', async () => {
    const { seen } = install();
    const { router } = await renderLoadedApp(path);
    await screen.findByText('Order intake', {}, coldStart);
    await userEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ period: '90d' });
    });
    await waitFor(() => {
      expect(seen.some((query) => query.get('period') === '90d')).toBe(true);
    });
  });

  it('shows the seven latest days and narrows the failure link to the chosen dates', async () => {
    install();
    await renderLoadedApp(path);
    const perDay = within(
      await screen.findByRole('region', { name: 'Runs per day' }),
    );
    const actor = userEvent.setup();
    await actor.click(perDay.getByRole('button', { name: '7 days' }));
    await actor.click(
      await perDay.findByText('Daily data', { selector: 'summary' }),
    );
    expect(perDay.getAllByRole('row')).toHaveLength(8);
    await actor.click(
      perDay.getByRole('button', { name: 'When: Choose dates' }),
    );
    await actor.click(
      screen.getByRole('button', { name: 'Saturday, October 17, 2026' }),
    );
    const failures = perDay.getByRole('link', { name: 'View failed runs' });
    expect(failures).toHaveAttribute(
      'href',
      expect.stringContaining('status=failed'),
    );
    expect(failures).toHaveAttribute(
      'href',
      expect.stringContaining('2026-10-17'),
    );
    expect(failures).toHaveAttribute(
      'href',
      expect.stringContaining('2026-10-18'),
    );
    expect(perDay.getAllByRole('row')).toHaveLength(2);
  });

  it('does not read capacity in a workspace being deleted, while runs per day remain', async () => {
    const { reads } = install({
      state: 'pending_deletion',
      caps: [
        'workspace:read',
        'run:read',
        'artifact:read',
        'workflow:read',
        'workspace:manage',
      ],
    });
    await renderLoadedApp(path);
    await screen.findByText('Order intake', {}, coldStart);
    expect(
      screen.getByText(
        'Current capacity isn’t available for a workspace being deleted.',
      ),
    ).toBeVisible();
    expect(reads()).toBe(0);
  });

  it('requires runs and files for capacity, but only runs for runs per day', async () => {
    const { reads } = install({ caps: ['workspace:read', 'run:read'] });
    await renderLoadedApp(path);
    await screen.findByRole('region', { name: 'By workflow' }, coldStart);
    expect(
      screen.getByText('You need access to runs and files to see capacity.'),
    ).toBeVisible();
    expect(reads()).toBe(0);
  });

  it('reads neither snapshot without access to runs', async () => {
    const { reads, seen } = install({
      caps: ['workspace:read', 'artifact:read'],
    });
    await renderLoadedApp(path);
    await screen.findByText(
      'You need access to runs to see how many ran.',
      {},
      coldStart,
    );
    expect(reads()).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('shows unavailable execution limits and actual zero storage limits distinctly', async () => {
    install({
      snapshot: {
        ...capacity,
        execution: {
          ...capacity.execution,
          policy: {
            state: 'unavailable',
            version: null,
            activeRunLimit: null,
            queuedRunLimit: null,
          },
        },
        artifacts: {
          chargedBytes: '0',
          byteLimit: '0',
          chargedCount: 0,
          artifactCountLimit: 0,
          source: 'default',
        },
      },
    });
    await renderLoadedApp(path);
    await screen.findByText('unavailable', { selector: 'strong' }, coldStart);
    const room = screen.getByRole('region', { name: 'Room left' });
    expect(room).toHaveTextContent('runs are going at once');
    expect(room).not.toHaveTextContent(/of \d+ runs at once/u);
    expect(room).toHaveTextContent('no storage capacity');
  });

  it.each(['expired', 'suspended', 'not_yet_effective'])(
    'does not describe a %s policy as unlimited or effective',
    async (state) => {
      install({
        snapshot: {
          ...capacity,
          execution: {
            ...capacity.execution,
            policy: { ...capacity.execution.policy, state },
          },
        },
      });
      await renderLoadedApp(path);
      await screen.findByText(
        /New runs aren’t accepted right now/u,
        {},
        coldStart,
      );
      expect(
        screen.getByRole('region', { name: 'Room left' }),
      ).toHaveTextContent('2 of 5 runs at once');
    },
  );

  it.each([401, 403, 404, 409])(
    'forgets capacity after %s until fresh success, including remount and later failures',
    async (denial) => {
      let status = 200;
      let fresh = false;
      install({
        capacityResponse: () =>
          status === 200
            ? HttpResponse.json(
                fresh
                  ? {
                      ...capacity,
                      artifacts: { ...capacity.artifacts, chargedBytes: '42' },
                    }
                  : capacity,
              )
            : new HttpResponse(null, { status }),
      });
      const refresh = () =>
        userEvent.click(
          screen.getByRole('button', { name: 'Refresh room left' }),
        );
      const { router } = await renderLoadedApp(path);
      await screen.findByText('8 PB', { selector: 'span' }, coldStart);
      status = 503;
      await refresh();
      await screen.findByText(/Couldn’t refresh. Showing results/u);
      expect(screen.getByText('8 PB', { selector: 'span' })).toBeVisible();
      status = denial;
      await refresh();
      await waitFor(() =>
        expect(
          screen.queryByText('8 PB', { selector: 'span' }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getByText('Order intake')).toBeVisible();
      status = 503;
      await refresh();
      await screen.findByText('Room left couldn’t be loaded. Try again.');
      await act(() =>
        router.navigate({
          to: '/w/$workspaceId/settings',
          params: { workspaceId: fixtureIds.workspace },
        }),
      );
      await act(() =>
        router.navigate({
          to: '/w/$workspaceId/settings/usage',
          params: { workspaceId: fixtureIds.workspace },
          search: { period: '30d' },
        }),
      );
      await screen.findByText('Room left couldn’t be loaded. Try again.');
      expect(
        screen.queryByText('8 PB', { selector: 'span' }),
      ).not.toBeInTheDocument();
      fresh = true;
      status = 200;
      await refresh();
      expect(
        await screen.findByText('42 B', { selector: 'span' }),
      ).toBeVisible();
      expect(
        screen.queryByText('8 PB', { selector: 'span' }),
      ).not.toBeInTheDocument();
    },
  );
});
