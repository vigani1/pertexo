import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { localTimeZone } from '@/lib/format-time';
import {
  describeOccurrence,
  describeScheduleHold,
} from '@/features/workflow-settings/model/occurrence-outcome';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  installQueries,
  schedule,
  scheduleId,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const triggersPath = `/w/${workspaceId}/workflows/${workflowId}/triggers`;
const runId = '77777777-7777-4777-8777-777777777777';
const occurrencesPath = `${workflowApi}/triggers/${scheduleId}/schedule/occurrences`;
const nextRunsPath = `${workflowApi}/triggers/${scheduleId}/schedule/next-runs`;

function occurrence(
  id: string,
  scheduledAt: string,
  outcome: 'accepted' | 'skipped',
  recordedAt = scheduledAt,
) {
  return {
    id,
    scheduledAt,
    recordedAt,
    outcome,
    runId: outcome === 'accepted' ? runId : null,
  };
}

async function scheduleCard() {
  return screen.findByRole('article', { name: 'Schedule: Nightly check' });
}

describe('schedule run history in words', () => {
  it('says whether a run started on time, caught up late or was skipped', () => {
    expect(
      describeOccurrence(
        occurrence('a', '2026-09-14T10:00:00.000Z', 'accepted'),
      ),
    ).toEqual({ tone: 'success', label: 'Started a run', detail: 'On time.' });
    expect(
      describeOccurrence(
        occurrence(
          'b',
          '2026-09-14T10:00:00.000Z',
          'accepted',
          '2026-09-14T12:05:00.000Z',
        ),
      ).detail,
    ).toBe('Caught up 2h 05m after this run time was due.');
    expect(
      describeOccurrence(
        occurrence('c', '2026-09-14T10:00:00.000Z', 'skipped'),
      ),
    ).toMatchObject({ tone: 'skipped', label: 'Skipped' });
  });

  it('explains attempts that never became a run time only while it is on', () => {
    expect(
      describeScheduleHold({
        status: 'active',
        lastErrorCode: 'schedule.admission_throttled',
      }),
    ).toMatch(/too many runs are waiting/u);
    expect(
      describeScheduleHold({
        status: 'active',
        lastErrorCode: 'schedule.scan_failed',
      }),
    ).toMatch(/couldn’t start the latest run time/u);
    expect(
      describeScheduleHold({
        status: 'disabled',
        lastErrorCode: 'schedule.admission_throttled',
      }),
    ).toBeUndefined();
    expect(
      describeScheduleHold({ status: 'active', lastErrorCode: null }),
    ).toBeUndefined();
  });
});

describe('schedule card on the Triggers tab', () => {
  it('lists the next three runs the scheduler reports', async () => {
    installQueries();
    renderApp(triggersPath);
    const card = await scheduleCard();
    const list = await within(card).findByRole('list', { name: 'Next runs' });
    const times = within(list).getAllByRole('listitem');
    expect(times).toHaveLength(3);
    expect(times.map((item) => item.querySelector('time')?.dateTime)).toEqual([
      '2026-09-14T10:15:00.000Z',
      '2026-09-14T10:30:00.000Z',
      '2026-09-14T10:45:00.000Z',
    ]);
    // An interval has no clock of its own, so it reads in local time only.
    expect(within(list).queryByText(/your time/u)).not.toBeInTheDocument();
  });

  it('shows a cron schedule’s runs on its own clock across a DST change', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({
          items: [
            {
              ...schedule,
              recurrence: {
                kind: 'cron',
                expression: '30 2 * * *',
                timezone: 'America/New_York',
              },
              nextFireAt: '2027-03-13T07:30:00.000Z',
            },
          ],
        }),
      ),
      http.get(nextRunsPath, () =>
        HttpResponse.json({
          observedAt: '2027-03-13T00:00:00.000Z',
          items: [
            { scheduledAt: '2027-03-13T07:30:00.000Z' },
            { scheduledAt: '2027-03-14T07:00:00.000Z' },
            { scheduledAt: '2027-03-15T06:30:00.000Z' },
          ],
        }),
      ),
    );
    renderApp(triggersPath);
    const card = await scheduleCard();
    const list = await within(card).findByRole('list', { name: 'Next runs' });
    const [before, gap, after] = within(list).getAllByRole('listitem');
    expect(before).toHaveTextContent(/\b0?2:30.*EST/u);
    expect(gap).toHaveTextContent(/\b0?3:00.*EDT/u);
    expect(after).toHaveTextContent(/\b0?2:30.*EDT/u);
    if (localTimeZone() !== 'America/New_York')
      expect(within(list).getAllByText(/your time/u)).toHaveLength(3);
  });

  it('says nothing runs while the schedule is off', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({
          items: [
            { ...schedule, status: 'disabled', healthStatus: 'disabled' },
          ],
        }),
      ),
      http.get(nextRunsPath, () =>
        HttpResponse.json({ observedAt: schedule.nextFireAt, items: [] }),
      ),
    );
    renderApp(triggersPath);
    const card = await scheduleCard();
    expect(
      await within(card).findByText(
        'Paused — nothing runs until the schedule is turned back on.',
      ),
    ).toBeVisible();
    expect(
      within(card).queryByRole('list', { name: 'Next runs' }),
    ).not.toBeInTheDocument();
  });

  it('keeps one failure owner for next runs and recovers on Retry', async () => {
    let failing = true;
    installQueries();
    mockServer.use(
      http.get(nextRunsPath, () =>
        failing
          ? HttpResponse.json(
              {
                type: 'about:blank',
                title: 'Unavailable',
                status: 503,
                code: 'internal.unavailable',
              },
              { status: 503 },
            )
          : HttpResponse.json({
              observedAt: schedule.nextFireAt,
              items: [{ scheduledAt: schedule.nextFireAt }],
            }),
      ),
    );
    renderApp(triggersPath);
    const card = await scheduleCard();
    expect(
      await within(card).findByText('Next runs couldn’t be loaded. Try again.'),
    ).toBeVisible();
    failing = false;
    await userEvent
      .setup()
      .click(within(card).getByRole('button', { name: 'Retry' }));
    expect(
      await within(card).findByRole('list', { name: 'Next runs' }),
    ).toBeVisible();
  });

  it('lists recent runs with outcome words, run links and older pages', async () => {
    const afterCursors: (string | null)[] = [];
    installQueries();
    mockServer.use(
      http.get(occurrencesPath, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        afterCursors.push(after);
        return HttpResponse.json(
          after === 'older'
            ? {
                items: [
                  occurrence(
                    '88888888-0000-4000-8000-000000000003',
                    '2026-09-14T09:30:00.000Z',
                    'skipped',
                  ),
                ],
                nextCursor: null,
              }
            : {
                items: [
                  occurrence(
                    '88888888-0000-4000-8000-000000000001',
                    '2026-09-14T10:00:00.000Z',
                    'accepted',
                  ),
                  occurrence(
                    '88888888-0000-4000-8000-000000000002',
                    '2026-09-14T09:45:00.000Z',
                    'accepted',
                    '2026-09-14T09:52:30.000Z',
                  ),
                ],
                nextCursor: 'older',
              },
        );
      }),
    );
    renderApp(triggersPath);
    const card = await scheduleCard();
    const list = await within(card).findByRole('list', {
      name: 'Recent runs of this schedule',
    });
    const [onTime, late] = within(list).getAllByRole('listitem');
    if (onTime === undefined || late === undefined)
      throw new Error('Expected two run times');
    expect(within(onTime).getByText('Started a run')).toBeVisible();
    expect(within(onTime).getByText('On time.')).toBeVisible();
    expect(
      within(onTime).getByRole('link', { name: 'Open run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);
    expect(within(late).getByText(/Caught up 7m 30s after/u)).toBeVisible();

    await userEvent
      .setup()
      .click(
        within(card).getByRole('button', { name: 'Load older run times' }),
      );
    const skipped = await within(list).findByText('Skipped');
    expect(
      within(skipped.closest('li') ?? list).queryByRole('link', {
        name: 'Open run',
      }),
    ).not.toBeInTheDocument();
    expect(afterCursors).toEqual([null, 'older']);
    expect(
      within(card).queryByRole('button', { name: 'Load older run times' }),
    ).not.toBeInTheDocument();
  });

  it('is honest when nothing has run yet and when runs are held back', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({
          items: [
            {
              ...schedule,
              healthStatus: 'degraded',
              lastErrorCode: 'schedule.admission_throttled',
            },
          ],
        }),
      ),
    );
    renderApp(triggersPath);
    const card = await scheduleCard();
    expect(await within(card).findByText(/No run times yet\./u)).toBeVisible();
    expect(
      within(card).getByText(/too many runs are waiting in this workspace/u),
    ).toBeVisible();
  });
});
