// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runFilterChips } from '@/features/workflow-runs/model/run-filter-labels';
import {
  customRangeInputs,
  customRangeSearch,
  filtersFromSearch,
  presetRangeSearch,
  sanitizeRunSearch,
  sanitizeWorkflowRunSearch,
  withoutRunFilter,
} from '@/features/workflow-runs/model/run-search';

const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('run search', () => {
  it('keeps valid keys and drops unknown or malformed ones', () => {
    expect(
      sanitizeRunSearch({
        status: 'sideways',
        createdAtFrom: 'yesterday',
        workflowId: 'nope',
        unknown: 1,
        trigger: 'webhook',
        view: 'grid',
      }),
    ).toEqual({ trigger: 'webhook' });
    expect(sanitizeRunSearch('not an object')).toEqual({});
    expect(sanitizeRunSearch(null)).toEqual({});
  });

  it('normalises bounds, drops an inverted upper bound and orphaned presets', () => {
    expect(
      sanitizeRunSearch({
        status: 'failed',
        workflowId,
        workflowNamePrefix: 2026,
        createdAtFrom: '2026-09-16T00:00:00Z',
        createdAtBefore: '2026-09-15T00:00:00Z',
        range: 'custom',
        view: 'loom',
      }),
    ).toEqual({
      status: 'failed',
      workflowId,
      workflowNamePrefix: '2026',
      createdAtFrom: '2026-09-16T00:00:00.000000Z',
      range: 'custom',
      view: 'loom',
    });
    expect(sanitizeRunSearch({ range: '24h' })).toEqual({});
  });

  it('separates API filters from view state and hub-fixed keys', () => {
    const search = sanitizeRunSearch({
      status: 'running',
      workflowId,
      trigger: 'manual',
      view: 'loom',
    });
    expect(filtersFromSearch(search)).toEqual({
      status: 'running',
      workflowId,
    });
    expect(
      sanitizeWorkflowRunSearch({ workflowId, workflowNamePrefix: 'Inv' }),
    ).toEqual({});
  });

  it('builds presets from now and custom ranges from local calendar days', () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect(presetRangeSearch({ status: 'failed' }, '24h', now)).toEqual({
      status: 'failed',
      range: '24h',
      createdAtFrom: '2026-09-23T12:00:00.000000Z',
    });
    const custom = customRangeSearch({}, '2026-09-14', '2026-09-15');
    expect(custom).toEqual({
      ok: true,
      search: {
        range: 'custom',
        createdAtFrom: new Date(2026, 8, 14)
          .toISOString()
          .replace('.000Z', '.000000Z'),
        createdAtBefore: new Date(2026, 8, 16)
          .toISOString()
          .replace('.000Z', '.000000Z'),
      },
    });
    if (custom.ok)
      expect(customRangeInputs(custom.search)).toEqual({
        from: '2026-09-14',
        to: '2026-09-15',
      });
    expect(customRangeSearch({}, '2026-09-15', '2026-09-14')).toEqual({
      ok: false,
      message: 'The end date must be on or after the start date.',
    });
    expect(customRangeSearch({}, '', '')).toMatchObject({ ok: false });
  });

  it('removes a time bound together with its preset', () => {
    expect(
      withoutRunFilter(
        {
          range: '24h',
          createdAtFrom: '2026-09-23T12:00:00.000000Z',
          status: 'failed',
        },
        'createdAtFrom',
      ),
    ).toEqual({ status: 'failed' });
  });

  it('labels applied filters in words', () => {
    expect(
      runFilterChips(
        {
          workflowId,
          status: 'timed_out',
          trigger: 'schedule',
          range: '7d',
          createdAtFrom: '2026-09-17T12:00:00.000000Z',
        },
        'Invoice intake',
      ).map((chip) => chip.label),
    ).toEqual([
      'Workflow: Invoice intake',
      'Status: Timed out',
      'When: Last 7 days',
      'Trigger: Schedule',
    ]);
  });
});
