import type { FieldParseResult, NodeConfig } from './inspector-draft';

// The Schedule step's builder: what the catalog's setup schema allows, the
// builder's editable draft, and the exact config it writes. The config keeps
// the step's own shape (ADR 014): `{ kind: 'cron', expression, timezone }`
// or `{ kind: 'interval', intervalMinutes }`, each with `misfirePolicy` when
// the schema has one. The server still validates the saved draft.

export type ScheduleMode = 'every' | 'daily' | 'weekdays' | 'weekly' | 'custom';
export type IntervalUnit = 'minutes' | 'hours';

export type ScheduleSchema = Readonly<{
  cron: Readonly<{ minLength: number; maxLength: number }> | undefined;
  interval: Readonly<{ minimum: number; maximum: number }> | undefined;
  misfire:
    Readonly<{ policies: readonly string[]; fallback: string }> | undefined;
}>;

export type ScheduleDraft = Readonly<{
  mode: ScheduleMode;
  /** The N of “every N minutes or hours”, as typed. */
  every: string;
  unit: IntervalUnit;
  /** “HH:MM” for the daily, weekday and weekly rules. */
  time: string;
  /** Days of the week for the weekly rule, 0 = Sunday. */
  days: readonly number[];
  expression: string;
  timezone: string;
  misfirePolicy: string;
}>;

export type ScheduleIssue = Readonly<{
  field: 'every' | 'time' | 'days' | 'expression' | 'timezone' | 'mode';
  message: string;
}>;

/** What the rule means, in the published trigger's recurrence shape. */
export type ScheduleRecurrence =
  | Readonly<{ kind: 'cron'; expression: string; timezone: string }>
  | Readonly<{ kind: 'interval'; intervalMinutes: number }>;

/**
 * Reads the Schedule step's JSON Schema: one branch per `kind`. Returns
 * undefined for a shape the builder doesn't know, so the Setup tab falls
 * back to editing the config as JSON rather than guessing.
 */
export function readScheduleSchema(
  schema: unknown,
): ScheduleSchema | undefined {
  const branches = isRecord(schema)
    ? (Reflect.get(schema, 'oneOf') ?? Reflect.get(schema, 'anyOf'))
    : undefined;
  if (!Array.isArray(branches)) return undefined;
  let cron: ScheduleSchema['cron'];
  let interval: ScheduleSchema['interval'];
  let misfire: ScheduleSchema['misfire'];
  for (const branch of branches) {
    const properties: unknown = isRecord(branch)
      ? Reflect.get(branch, 'properties')
      : undefined;
    if (!isRecord(properties)) continue;
    const kind = recordOf(properties.kind)?.const;
    if (kind === 'cron' && isRecord(properties.timezone))
      cron = {
        minLength: numberOr(recordOf(properties.expression)?.minLength, 1),
        maxLength: numberOr(recordOf(properties.expression)?.maxLength, 255),
      };
    if (kind === 'interval' && isRecord(properties.intervalMinutes))
      interval = {
        minimum: numberOr(properties.intervalMinutes.minimum, 1),
        maximum: numberOr(properties.intervalMinutes.maximum, 43_200),
      };
    misfire ??= readMisfire(properties.misfirePolicy);
  }
  return cron === undefined && interval === undefined
    ? undefined
    : { cron, interval, misfire };
}

function readMisfire(property: unknown): ScheduleSchema['misfire'] {
  const values = recordOf(property)?.enum;
  if (!Array.isArray(values)) return undefined;
  const policies = values.filter(
    (value): value is string => typeof value === 'string',
  );
  const preferred = recordOf(property)?.default;
  const fallback =
    typeof preferred === 'string' && policies.includes(preferred)
      ? preferred
      : policies[0];
  return fallback === undefined ? undefined : { policies, fallback };
}

/** The config's rule as the builder shows it, with defaults for the rest. */
export function draftFromConfig(
  config: NodeConfig,
  schema: ScheduleSchema,
  fallbackTimezone: string,
): ScheduleDraft {
  const policy = config.misfirePolicy;
  const base: ScheduleDraft = {
    mode: schema.cron === undefined ? 'every' : 'daily',
    every: '15',
    unit: 'minutes',
    time: '09:00',
    days: [1],
    expression: '0 9 * * *',
    timezone: fallbackTimezone,
    misfirePolicy:
      typeof policy === 'string' ? policy : (schema.misfire?.fallback ?? ''),
  };
  const minutes = config.intervalMinutes;
  if (config.kind === 'interval' && typeof minutes === 'number')
    return minutes % 60 === 0
      ? { ...base, mode: 'every', every: String(minutes / 60), unit: 'hours' }
      : { ...base, mode: 'every', every: String(minutes), unit: 'minutes' };
  if (config.kind !== 'cron' || typeof config.expression !== 'string')
    return base;
  const draft = {
    ...base,
    expression: config.expression,
    timezone:
      typeof config.timezone === 'string' ? config.timezone : base.timezone,
  };
  return { ...draft, ...presetFor(draft) };
}

const PRESET = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7](?:,[0-7])*)$/u;

/** The friendlier rule an expression matches exactly, else “custom”. */
function presetFor(draft: ScheduleDraft): Partial<ScheduleDraft> {
  const [, minute = '', hour = '', weekday = ''] =
    PRESET.exec(draft.expression) ?? [];
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  const preset: Partial<ScheduleDraft> =
    weekday === '*'
      ? { mode: 'daily', time }
      : weekday === '1-5'
        ? { mode: 'weekdays', time }
        : {
            mode: 'weekly',
            time,
            days: [...new Set(weekday.split(',').map((day) => +day % 7))],
          };
  // Only when the builder writes the very same rule back; otherwise the
  // expression stays exactly as stored.
  return cronFor({ ...draft, ...preset }) === draft.expression
    ? preset
    : { mode: 'custom' };
}

/** The cron rule a draft stands for, or undefined while it's incomplete. */
export function cronFor(draft: ScheduleDraft): string | undefined {
  if (draft.mode === 'every') return undefined;
  if (draft.mode === 'custom')
    return draft.expression.trim().split(/\s+/u).join(' ');
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(draft.time);
  if (time === null) return undefined;
  const days =
    draft.mode === 'daily'
      ? '*'
      : draft.mode === 'weekdays'
        ? '1-5'
        : [...new Set(draft.days)].sort((a, b) => a - b).join(',');
  return `${String(Number(time[2]))} ${String(Number(time[1]))} * * ${days}`;
}

function intervalMinutes(draft: ScheduleDraft): number {
  return Number(draft.every.trim()) * (draft.unit === 'hours' ? 60 : 1);
}

/** The first thing keeping a draft from being a rule the schema accepts. */
export function scheduleIssue(
  draft: ScheduleDraft,
  schema: ScheduleSchema,
): ScheduleIssue | undefined {
  if (draft.mode === 'every') return intervalIssue(draft, schema.interval);
  if (schema.cron === undefined)
    return {
      field: 'mode',
      message: 'This step can only repeat every N minutes or hours.',
    };
  if (draft.mode === 'custom') {
    const issue = cronTextIssue(cronFor(draft) ?? '', schema.cron);
    if (issue !== undefined) return { field: 'expression', message: issue };
  } else if (cronFor(draft) === undefined)
    return { field: 'time', message: 'Enter a time like 09:00.' };
  if (draft.mode === 'weekly' && draft.days.length === 0)
    return { field: 'days', message: 'Pick at least one day.' };
  if (draft.timezone === '')
    return { field: 'timezone', message: 'Choose a timezone.' };
  if (draft.timezone.startsWith('Etc/GMT'))
    return {
      field: 'timezone',
      message:
        'Choose a place, not a fixed offset, so clock changes are followed.',
    };
  return undefined;
}

function intervalIssue(
  draft: ScheduleDraft,
  bounds: ScheduleSchema['interval'],
): ScheduleIssue | undefined {
  if (bounds === undefined)
    return { field: 'mode', message: 'This step can only follow a cron rule.' };
  if (!/^\d+$/u.test(draft.every.trim()))
    return { field: 'every', message: 'Enter a whole number, like 15.' };
  const minutes = intervalMinutes(draft);
  if (minutes < bounds.minimum)
    return {
      field: 'every',
      message: `The shortest gap is ${spanWords(bounds.minimum)}.`,
    };
  if (minutes > bounds.maximum)
    return {
      field: 'every',
      message: `The longest gap is ${spanWords(bounds.maximum)}.`,
    };
  return undefined;
}

/** Advisory checks only: the server parses the rule in its timezone. */
function cronTextIssue(
  expression: string,
  bounds: NonNullable<ScheduleSchema['cron']>,
): string | undefined {
  if (expression === '') return 'Enter a cron rule, like 0 9 * * 1-5.';
  if (expression.split(' ').length !== 5)
    return 'A cron rule has five parts: minute, hour, day of month, month and day of week.';
  if (/[H?#L]/u.test(expression))
    return 'H, L, # and ? aren’t supported. Use numbers, names, *, commas, ranges and steps.';
  if (!/^[0-9A-Za-z*,/ -]+$/u.test(expression))
    return 'Use numbers, names, *, commas, ranges and steps in a cron rule.';
  if (
    expression.length < bounds.minLength ||
    expression.length > bounds.maxLength
  )
    return `A cron rule is ${String(bounds.minLength)} to ${String(bounds.maxLength)} characters long.`;
  return undefined;
}

function spanWords(minutes: number): string {
  const [count, unit] =
    minutes % 1_440 === 0
      ? [minutes / 1_440, 'day']
      : minutes % 60 === 0
        ? [minutes / 60, 'hour']
        : [minutes, 'minute'];
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

/** The recurrence a finished draft describes, for its sentence preview. */
export function recurrenceFor(
  draft: ScheduleDraft,
  schema: ScheduleSchema,
): ScheduleRecurrence | undefined {
  if (scheduleIssue(draft, schema) !== undefined) return undefined;
  if (draft.mode === 'every')
    return { kind: 'interval', intervalMinutes: intervalMinutes(draft) };
  return {
    kind: 'cron',
    expression: cronFor(draft) ?? '',
    timezone: draft.timezone,
  };
}

/** The config a finished draft writes, or why it can't be written yet. */
export function configFromDraft(
  draft: ScheduleDraft,
  schema: ScheduleSchema,
): FieldParseResult<NodeConfig> {
  const recurrence = recurrenceFor(draft, schema);
  if (recurrence === undefined)
    return {
      ok: false,
      error: scheduleIssue(draft, schema)?.message ?? 'Finish the schedule.',
    };
  return {
    ok: true,
    value: {
      ...recurrence,
      ...(schema.misfire === undefined
        ? {}
        : { misfirePolicy: draft.misfirePolicy }),
    },
  };
}

let timezones: readonly string[] | undefined;

/** Place-based IANA timezones this browser knows, fixed offsets left out. */
export function timezoneChoices(current: string): readonly string[] {
  timezones ??= supportedTimezones().filter(
    (zone) => !zone.startsWith('Etc/GMT'),
  );
  return current === '' || timezones.includes(current)
    ? timezones
    : [current, ...timezones];
}

/** This browser's timezone when it's one people can pick, otherwise ''. */
export function browserTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezoneChoices('').includes(zone) ? zone : '';
}

function supportedTimezones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown) {
  return isRecord(value) ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
