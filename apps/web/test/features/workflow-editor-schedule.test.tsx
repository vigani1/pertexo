import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  configFromDraft,
  cronFor,
  draftFromConfig,
  readScheduleSchema,
  scheduleIssue,
  type ScheduleDraft,
  type ScheduleSchema,
} from '@/features/workflow-editor/model/schedule-draft';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  choose,
  editorHandlers,
  editorPath,
  findCanvas,
  pressSave,
  setDefinition,
} from '../support/workflow-editor-fixtures';

const misfirePolicy = {
  default: 'catch_up_once',
  type: 'string',
  enum: ['catch_up_once', 'skip'],
};

/** The JSON Schema the catalog publishes for `core.schedule` setup. */
const scheduleConfigSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'cron' },
        expression: { type: 'string', minLength: 9, maxLength: 255 },
        timezone: { type: 'string', minLength: 1, maxLength: 255 },
        misfirePolicy,
      },
      required: ['kind', 'expression', 'timezone', 'misfirePolicy'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'interval' },
        intervalMinutes: { type: 'integer', minimum: 1, maximum: 43_200 },
        misfirePolicy,
      },
      required: ['kind', 'intervalMinutes', 'misfirePolicy'],
      additionalProperties: false,
    },
  ],
};

const scheduleDefinition = {
  ...setDefinition,
  definition: { key: 'core.schedule', version: 3 },
  family: 'trigger',
  configVersion: 3,
  configSchema: scheduleConfigSchema,
  ports: { inputs: [], outputs: ['out'] },
} satisfies NodeDefinitionCatalogItem;

function readSchema(): ScheduleSchema {
  const schema = readScheduleSchema(scheduleConfigSchema);
  if (schema === undefined) throw new Error('schedule schema not understood');
  return schema;
}

function draftOf(config: Record<string, unknown>): ScheduleDraft {
  return draftFromConfig(config as never, readSchema(), 'Europe/Berlin');
}

describe('schedule builder model', () => {
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

function scheduleGraph(
  config: WorkflowGraphContract['nodes'][number]['config'],
): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'nightly',
        label: 'Nightly',
        definition: { key: 'core.schedule', version: 3 },
        position: { x: 80, y: 80 },
        configVersion: 3,
        config,
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
}

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
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Nightly'));
    expect(screen.getByText('Not scheduled yet')).toBeVisible();

    await choose(event, 'Runs', 'Weekdays at a time');
    await choose(event, 'Timezone', 'Europe/Berlin');
    fireEvent.change(screen.getByLabelText('At'), {
      target: { value: '08:30' },
    });
    const preview = screen.getByRole('region', { name: 'When it runs' });
    expect(preview).toHaveTextContent('Every weekday at 08:30');
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
    );
    try {
      renderApp(editorPath);
      const event = userEvent.setup();
      fireEvent.click((await findCanvas()).getByText('Nightly'));
      expect(
        screen.getByRole('region', { name: 'When it runs' }),
      ).toHaveTextContent('Every day at 09:00');
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
