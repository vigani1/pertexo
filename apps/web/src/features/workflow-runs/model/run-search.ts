import {
  normalizeWorkflowRunCreatedAt,
  workflowRunListQuerySchema,
  workflowRunTriggerTypeSchema,
  type WorkflowRunListQuery,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { RunTriggerType } from './run-status';

/** The run-list filters the API applies. */
export type RunHistoryFilters = Readonly<
  Pick<
    WorkflowRunListQuery,
    | 'workflowId'
    | 'workflowNamePrefix'
    | 'status'
    | 'createdAtFrom'
    | 'createdAtBefore'
  >
>;

export type RunTimeRange = '1h' | '24h' | '7d' | '30d' | 'custom';
export type RunPresetRange = Exclude<RunTimeRange, 'custom'>;

/**
 * Everything the Runs URL can hold: the API filters, the time preset that
 * produced them, a client-side trigger filter and the Loom view.
 */
export type RunSearch = RunHistoryFilters &
  Readonly<{
    range?: RunTimeRange;
    trigger?: RunTriggerType;
    view?: 'loom';
  }>;

/** The workflow hub fixes the workflow, so its URL never carries one. */
export type WorkflowRunSearch = Omit<
  RunSearch,
  'workflowId' | 'workflowNamePrefix'
>;

export const runPresetRanges: readonly RunPresetRange[] = [
  '1h',
  '24h',
  '7d',
  '30d',
];

const presetDurationsMs: Readonly<Record<RunPresetRange, number>> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

const timeRanges = new Set<string>([...runPresetRanges, 'custom']);
const filterShape = workflowRunListQuerySchema.shape;
const timeKeys = ['createdAtFrom', 'createdAtBefore', 'range'] as const;

function omitKeys<Value extends object, Key extends keyof Value>(
  value: Value,
  keys: readonly Key[],
): Omit<Value, Key> {
  const omitted = new Set<PropertyKey>(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  ) as Omit<Value, Key>;
}

function stringValue(value: unknown): unknown {
  // The router decodes `?workflowNamePrefix=2026` as a number.
  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : value;
}

function parseField<Key extends keyof RunHistoryFilters>(
  key: Key,
  value: unknown,
): RunHistoryFilters[Key] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = filterShape[key].safeParse(stringValue(value));
  return parsed.success
    ? (parsed.data as RunHistoryFilters[Key] | undefined)
    : undefined;
}

function readApiFilters(
  record: Readonly<Record<string, unknown>>,
): RunHistoryFilters {
  const workflowId = parseField('workflowId', record.workflowId);
  const workflowNamePrefix = parseField(
    'workflowNamePrefix',
    record.workflowNamePrefix,
  );
  const status = parseField('status', record.status);
  const createdAtFrom = parseField('createdAtFrom', record.createdAtFrom);
  const parsedBefore = parseField('createdAtBefore', record.createdAtBefore);
  const createdAtBefore =
    parsedBefore !== undefined &&
    createdAtFrom !== undefined &&
    createdAtFrom >= parsedBefore
      ? undefined
      : parsedBefore;
  return {
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(workflowNamePrefix === undefined ? {} : { workflowNamePrefix }),
    ...(status === undefined ? {} : { status }),
    ...(createdAtFrom === undefined ? {} : { createdAtFrom }),
    ...(createdAtBefore === undefined ? {} : { createdAtBefore }),
  };
}

function readRange(
  value: unknown,
  filters: RunHistoryFilters,
): RunTimeRange | undefined {
  if (typeof value !== 'string' || !timeRanges.has(value)) return undefined;
  const hasBounds =
    filters.createdAtFrom !== undefined ||
    filters.createdAtBefore !== undefined;
  return hasBounds ? (value as RunTimeRange) : undefined;
}

/**
 * Keeps every valid key and silently drops unknown or malformed ones, so a
 * hand-edited or outdated link opens the page instead of the error screen.
 */
export function sanitizeRunSearch(value: unknown): RunSearch {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {};
  const record = value as Readonly<Record<string, unknown>>;
  const filters = readApiFilters(record);
  const range = readRange(record.range, filters);
  const trigger = workflowRunTriggerTypeSchema.safeParse(record.trigger);
  return {
    ...filters,
    ...(range === undefined ? {} : { range }),
    ...(trigger.success ? { trigger: trigger.data } : {}),
    ...(record.view === 'loom' ? { view: 'loom' as const } : {}),
  };
}

export function sanitizeWorkflowRunSearch(value: unknown): WorkflowRunSearch {
  return omitKeys(sanitizeRunSearch(value), [
    'workflowId',
    'workflowNamePrefix',
  ]);
}

/**
 * The subset the API filters on; changes here refetch the list. Reads only
 * known, valid keys: the router keeps unknown URL keys beside the validated
 * ones, and the API rejects anything it doesn't know.
 */
export function filtersFromSearch(search: RunSearch): RunHistoryFilters {
  return readApiFilters(search);
}

/** Whether anything narrows the list (the view toggle doesn't). */
export function hasRunFilters(search: RunSearch): boolean {
  return Object.keys(search).some((key) => key !== 'view');
}

/** Clears every filter but keeps the chosen view. */
export function clearedRunSearch(search: RunSearch): RunSearch {
  return search.view === undefined ? {} : { view: search.view };
}

export function withRunView<Search extends RunSearch>(
  search: Search,
  view: 'list' | 'loom',
): Search {
  const rest = omitKeys(search, ['view']);
  return (view === 'loom' ? { ...rest, view } : rest) as Search;
}

/** Drops the time filter keys so a new range can replace them. */
export function withoutTimeRange<Search extends RunSearch>(
  search: Search,
): Omit<Search, (typeof timeKeys)[number]> {
  return omitKeys(search, timeKeys);
}

/** Removes one filter key; removing a bound also forgets the preset. */
export function withoutRunFilter<Search extends RunSearch>(
  search: Search,
  key: keyof RunSearch,
): Search {
  if (key === 'createdAtFrom' || key === 'createdAtBefore')
    return omitKeys(search, [key, 'range']) as Search;
  return omitKeys(search, [key]) as Search;
}

function normalizedInstant(epochMs: number): string {
  return normalizeWorkflowRunCreatedAt(new Date(epochMs).toISOString());
}

/** A rolling preset measured back from `nowMs`. */
export function presetRangeSearch<Search extends RunSearch>(
  search: Search,
  range: RunPresetRange,
  nowMs: number,
): Search {
  return {
    ...withoutTimeRange(search),
    range,
    createdAtFrom: normalizedInstant(nowMs - presetDurationsMs[range]),
  } as Search;
}

/** Local midnight of `YYYY-MM-DD`, optionally some days later. */
function localMidnight(dateValue: string, dayOffset = 0): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateValue);
  if (match === null) return undefined;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + dayOffset,
  );
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export type CustomRangeResult<Search> =
  | Readonly<{ ok: true; search: Search }>
  | Readonly<{ ok: false; message: string }>;

/**
 * A custom range from two calendar days in the person's own time zone. The
 * end day is inclusive, so the exclusive bound is the local midnight after.
 */
export function customRangeSearch<Search extends RunSearch>(
  search: Search,
  fromDate: string,
  toDate: string,
): CustomRangeResult<Search> {
  const from = fromDate === '' ? undefined : localMidnight(fromDate);
  const before = toDate === '' ? undefined : localMidnight(toDate, 1);
  if (
    (fromDate !== '' && from === undefined) ||
    (toDate !== '' && before === undefined)
  )
    return { ok: false, message: 'Enter each date as year, month and day.' };
  if (from === undefined && before === undefined)
    return { ok: false, message: 'Choose a start date, an end date or both.' };
  if (from !== undefined && before !== undefined && from >= before)
    return {
      ok: false,
      message: 'The end date must be on or after the start date.',
    };
  return {
    ok: true,
    search: {
      ...withoutTimeRange(search),
      range: 'custom',
      ...(from === undefined ? {} : { createdAtFrom: normalizedInstant(from) }),
      ...(before === undefined
        ? {}
        : { createdAtBefore: normalizedInstant(before) }),
    } as Search,
  };
}

/** A local calendar day for a date input, e.g. `2026-09-24`. */
export function localDateValue(epochMs: number | undefined): string {
  if (epochMs === undefined || Number.isNaN(epochMs)) return '';
  const date = new Date(epochMs);
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Date-input values for the current custom range (end day inclusive). */
export function customRangeInputs(
  search: RunSearch,
): Readonly<{ from: string; to: string }> {
  return {
    from:
      search.createdAtFrom === undefined
        ? ''
        : localDateValue(Date.parse(search.createdAtFrom)),
    to:
      search.createdAtBefore === undefined
        ? ''
        : localDateValue(Date.parse(search.createdAtBefore) - 1),
  };
}
