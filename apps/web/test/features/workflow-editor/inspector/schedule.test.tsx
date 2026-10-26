import {
  configFromDraft,
  cronFor,
  readScheduleSchema,
  scheduleIssue,
} from '@/features/workflow-editor/model/inspector/schedule-draft';

import type { WorkflowGraphContract } from '@pertexo/contracts';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { describe, expect, it, vi } from 'vitest';

import {
  choose,
  findCanvas,
  pressSave,
} from '../../../support/fixtures/editor-actions';
import {
  editorHandlers,
  editorPath,
} from '../../../support/fixtures/workflow-editor';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  draftOf,
  previewHandler,
  readSchema,
  scheduleDefinition,
  scheduleGraph,
} from './schedule/fixture';

describe('schedule builder model', () => {
  it.each(['0 9 * * THU', '0 9 * JUL *', '0 9 * JUL THU', '0 9 * jul thu'])(
    'accepts the supported month/day names in %s',
    (expression) => {
      expect(
        scheduleIssue(
          { ...draftOf({}), mode: 'custom', expression },
          readSchema(),
        ),
      ).toBeUndefined();
      expect(
        configFromDraft(
          { ...draftOf({}), mode: 'custom', expression },
          readSchema(),
        ),
      ).toMatchObject({ ok: true, value: { expression } });
    },
  );
  it.each([
    'H 9 * * *',
    '0 9 L * *',
    '0 9 * * 4L',
    '0 9 * * THU#2',
    '0 9 ? JUL THU',
  ])('refuses unsupported operators in %s', (expression) => {
    const issue = scheduleIssue(
      { ...draftOf({}), mode: 'custom', expression },
      readSchema(),
    );
    expect(issue?.field).toBe('expression');
    expect(issue?.message).toContain('aren’t supported');
  });
  it('reads what the catalog’s schedule schema allows', () => {
    expect(readSchema()).toEqual({
      cron: { minLength: 9, maxLength: 255 },
      interval: { minimum: 1, maximum: 43_200 },
      misfire: {
        policies: ['catch_up_once', 'skip'],
        fallback: 'catch_up_once',
      },
    });
    expect(
      readScheduleSchema({ type: 'object', properties: {} }),
    ).toBeUndefined();
  });
  it('shows stored rules with the friendliest builder that writes them back exactly', () => {
    expect(draftOf({ kind: 'interval', intervalMinutes: 90 })).toMatchObject({
      mode: 'every',
      every: '90',
      unit: 'minutes',
    });
    expect(draftOf({ kind: 'interval', intervalMinutes: 120 })).toMatchObject({
      mode: 'every',
      every: '2',
      unit: 'hours',
    });
    const cron = (expression: string) =>
      draftOf({ kind: 'cron', expression, timezone: 'Asia/Tokyo' });
    expect(cron('30 8 * * *')).toMatchObject({ mode: 'daily', time: '08:30' });
    expect(cron('0 9 * * 1-5')).toMatchObject({
      mode: 'weekdays',
      timezone: 'Asia/Tokyo',
    });
    expect(cron('0 18 * * 1,4')).toMatchObject({
      mode: 'weekly',
      days: [1, 4],
      time: '18:00',
    });
    expect(cron('0 9 * * 4,1')).toMatchObject({
      mode: 'custom',
      expression: '0 9 * * 4,1',
    });
    expect(cron('0 9-17 * * *').mode).toBe('custom');
    expect(draftOf({})).toMatchObject({
      mode: 'daily',
      time: '09:00',
      timezone: 'Europe/Berlin',
      misfirePolicy: 'catch_up_once',
    });
  });
  it('writes the step’s own config shape and nothing else', () => {
    const schema = readSchema();
    const base = draftOf({});
    expect(
      configFromDraft(
        { ...base, mode: 'weekly', days: [5, 1], time: '07:05' },
        schema,
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: 'cron',
        expression: '5 7 * * 1,5',
        timezone: 'Europe/Berlin',
        misfirePolicy: 'catch_up_once',
      },
    });
    expect(
      configFromDraft(
        {
          ...base,
          mode: 'every',
          every: '6',
          unit: 'hours',
          misfirePolicy: 'skip',
        },
        schema,
      ),
    ).toEqual({
      ok: true,
      value: { kind: 'interval', intervalMinutes: 360, misfirePolicy: 'skip' },
    });
    expect(
      configFromDraft(
        { ...base, mode: 'custom', expression: '  0  9 * * MON-FRI ' },
        { ...schema, misfire: undefined },
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: 'cron',
        expression: '0 9 * * MON-FRI',
        timezone: 'Europe/Berlin',
      },
    });
    expect(cronFor({ ...base, mode: 'weekdays', time: '18:45' })).toBe(
      '45 18 * * 1-5',
    );
  });
  it.each([
    [{ mode: 'every', every: '0' }, 'every', 'The shortest gap is 1 minute.'],
    [
      { mode: 'every', every: '721', unit: 'hours' },
      'every',
      'The longest gap is 30 days.',
    ],
    [
      { mode: 'every', every: '1.5' },
      'every',
      'Enter a whole number, like 15.',
    ],
    [{ mode: 'daily', time: '9' }, 'time', 'Enter a time like 09:00.'],
    [{ mode: 'weekly', days: [] }, 'days', 'Pick at least one day.'],
    [
      { mode: 'custom', expression: '0 9 * *' },
      'expression',
      'A cron rule has five parts: minute, hour, day of month, month and day of week.',
    ],
    [
      { mode: 'custom', expression: 'H 9 * * *' },
      'expression',
      'H, L, # and ? aren’t supported. Use numbers, names, *, commas, ranges and steps.',
    ],
    [{ mode: 'daily', timezone: '' }, 'timezone', 'Choose a timezone.'],
    [
      { mode: 'daily', timezone: 'Etc/GMT+1' },
      'timezone',
      'Choose a place, not a fixed offset, so clock changes are followed.',
    ],
  ] as const)('explains %o', (patch, field, message) => {
    const issue = scheduleIssue({ ...draftOf({}), ...patch }, readSchema());
    expect(issue).toEqual({ field, message });
  });
});

describe('schedule builder in Setup', { timeout: 30_000 }, () => {
  it('builds a rule live, reads it back as a sentence and keeps bad rules as scratch', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        { graph: scheduleGraph({}), definitions: [scheduleDefinition] },
      ),
      previewHandler(),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Nightly'));
    expect(await screen.findByText('Not scheduled yet')).toBeVisible();

    await choose(event, 'Runs', 'Weekdays at a time');
    await choose(event, 'Timezone', 'Europe/Berlin');
    fireEvent.change(screen.getByLabelText('At'), {
      target: { value: '08:30' },
    });
    const preview = screen.getByRole('region', { name: 'When it runs' });
    expect(preview).toHaveTextContent('Every weekday at 8:30 AM');
    expect(preview).toHaveTextContent('Europe/Berlin time');
    expect(preview).toHaveTextContent(/a time that happens twice runs once/u);
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[0]?.config).toEqual({
        kind: 'cron',
        expression: '30 8 * * 1-5',
        timezone: 'Europe/Berlin',
        misfirePolicy: 'catch_up_once',
      });
    });
    expect(screen.queryByText('Not scheduled yet')).toBeNull();

    await choose(event, 'Runs', 'Custom cron rule');
    const rule = screen.getByLabelText('Cron rule');
    expect(rule).toHaveValue('30 8 * * 1-5');
    fireEvent.change(rule, { target: { value: 'H 8 * * *' } });
    fireEvent.blur(rule);
    expect(rule).toHaveAccessibleDescription(/aren’t supported/u);
    expect(
      screen.getByText('An edit isn’t valid yet, so it isn’t saved.'),
    ).toBeVisible();

    await choose(event, 'Runs', 'Every N minutes or hours');
    fireEvent.change(screen.getByLabelText('Every'), {
      target: { value: '2' },
    });
    await event.click(screen.getByRole('button', { name: 'hours' }));
    await event.click(screen.getByRole('button', { name: 'Skip them' }));
    expect(
      within(screen.getByRole('region', { name: 'When it runs' })).getByText(
        'Every 2 hours',
      ),
    ).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[0]?.config).toEqual({
        kind: 'interval',
        intervalMinutes: 120,
        misfirePolicy: 'skip',
      });
    });
  });
  it('uses the suggested rule, in this browser’s timezone, only when asked', async () => {
    // Node follows TZ at runtime, so the builder's browser timezone is known.
    vi.stubEnv('TZ', 'Europe/Berlin');
    let saves = 0;
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saves += 1;
          saved = body.graph;
        },
        { graph: scheduleGraph({}), definitions: [scheduleDefinition] },
      ),
      previewHandler(),
    );
    try {
      renderApp(editorPath);
      const event = userEvent.setup();
      fireEvent.click((await findCanvas()).getByText('Nightly'));
      expect(
        screen.getByRole('region', { name: 'When it runs' }),
      ).toHaveTextContent('Every day at 9:00 AM');
      pressSave();
      expect(saves).toBe(0);
      await event.click(
        screen.getByRole('button', { name: 'Use this schedule' }),
      );
      pressSave();
      await waitFor(() => {
        expect(saved?.nodes[0]?.config).toEqual({
          kind: 'cron',
          expression: '0 9 * * *',
          timezone: 'Europe/Berlin',
          misfirePolicy: 'catch_up_once',
        });
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
