import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

export const SCHEDULE_CRON_PARSER_VERSION = '5.10.0' as const;

const intervalSchema = z
  .object({
    kind: z.literal('interval'),
    intervalMinutes: z.number().int().min(1).max(43_200),
  })
  .strict();
const cronInputSchema = z
  .object({
    kind: z.literal('cron'),
    expression: z.string(),
    timezone: z.string(),
  })
  .strict();

export type ScheduleRecurrence =
  | Readonly<z.output<typeof intervalSchema>>
  | Readonly<{
      kind: 'cron';
      expression: string;
      timezone: string;
    }>;

export type ScheduleObservation = Readonly<{
  greatestDueAt: Date | null;
  nextAt: Date;
}>;

const canonicalTimezones = new Set(Intl.supportedValuesOf('timeZone'));

function invalidSchedule(error?: unknown): never {
  throw new TypeError('Invalid schedule recurrence', { cause: error });
}

export function parseScheduleRecurrence(input: unknown): ScheduleRecurrence {
  const interval = intervalSchema.safeParse(input);
  if (interval.success) return Object.freeze(interval.data);
  const cron = cronInputSchema.safeParse(input);
  if (!cron.success) return invalidSchedule(cron.error);
  const fields = cron.data.expression.trim().split(/\s+/u);
  if (
    fields.length !== 5 ||
    cron.data.expression !== fields.join(' ') ||
    !canonicalTimezones.has(cron.data.timezone) ||
    cron.data.timezone.startsWith('Etc/GMT') ||
    /[H?#L]/u.test(cron.data.expression)
  )
    return invalidSchedule();
  try {
    CronExpressionParser.parse(`0 ${cron.data.expression}`, {
      currentDate: new Date(0),
      strict: true,
      tz: cron.data.timezone,
    });
  } catch (error: unknown) {
    return invalidSchedule(error);
  }
  return Object.freeze(cron.data);
}

function cronParser(
  recurrence: Extract<ScheduleRecurrence, { kind: 'cron' }>,
  currentDate: Date,
) {
  return CronExpressionParser.parse(`0 ${recurrence.expression}`, {
    currentDate,
    strict: true,
    tz: recurrence.timezone,
  });
}

function localParts(
  date: Date,
  timezone: string,
): readonly [number, number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return [
    value('year'),
    value('month'),
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  ];
}

function offsetAt(date: Date, timezone: string): number {
  const [year, month, day, hour, minute, second] = localParts(date, timezone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - date.getTime();
}

function matchesLocalExpression(
  recurrence: Extract<ScheduleRecurrence, { kind: 'cron' }>,
  date: Date,
): boolean {
  const [year, month, day, hour, minute] = localParts(
    date,
    recurrence.timezone,
  );
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parser = CronExpressionParser.parse(`0 ${recurrence.expression}`, {
    currentDate: new Date(localAsUtc.getTime() - 1),
    strict: true,
    tz: 'UTC',
  });
  return parser.next().getTime() === localAsUtc.getTime();
}

function resolveCronOccurrence(
  recurrence: Extract<ScheduleRecurrence, { kind: 'cron' }>,
  raw: Date,
): Date {
  const occurrence = new Date(raw.getTime());
  if (matchesLocalExpression(recurrence, occurrence)) {
    const localIdentity = localParts(occurrence, recurrence.timezone).join(':');
    for (
      let cursor = occurrence.getTime() - 3 * 60 * 60_000;
      cursor < occurrence.getTime();
      cursor += 60_000
    ) {
      const candidate = new Date(cursor);
      if (
        localParts(candidate, recurrence.timezone).join(':') === localIdentity
      )
        return candidate;
    }
    return occurrence;
  }

  const currentOffset = offsetAt(occurrence, recurrence.timezone);
  let cursor = occurrence.getTime() - 24 * 60 * 60_000;
  let priorOffset = offsetAt(new Date(cursor), recurrence.timezone);
  for (cursor += 60_000; cursor <= occurrence.getTime(); cursor += 60_000) {
    const offset = offsetAt(new Date(cursor), recurrence.timezone);
    if (offset !== priorOffset && offset === currentOffset)
      return new Date(cursor);
    priorOffset = offset;
  }
  throw new TypeError('Cron parser produced a non-matching local occurrence');
}

function nextCronOccurrence(
  recurrence: Extract<ScheduleRecurrence, { kind: 'cron' }>,
  after: Date,
): Date {
  const cursor = cronParser(recurrence, after);
  for (;;) {
    const occurrence = resolveCronOccurrence(
      recurrence,
      cursor.next().toDate(),
    );
    // Resolution can move a repeated local time backwards. Advance the raw
    // parser cursor, never the resolved identity, to skip that duplicate.
    if (occurrence.getTime() > after.getTime()) return occurrence;
  }
}

function greatestCronOccurrence(
  recurrence: Extract<ScheduleRecurrence, { kind: 'cron' }>,
  observedAt: Date,
): Date {
  const cursor = cronParser(recurrence, new Date(observedAt.getTime() + 1));
  const previousRaw = cursor.prev().toDate();
  let raw = previousRaw;
  let greatest = resolveCronOccurrence(recurrence, raw);
  // A later raw instant in a repeated hour can resolve before an earlier raw
  // instant. Search only the adjusted window: resolution never moves forward,
  // so no raw instant at/before the best identity can improve that identity.
  while (raw.getTime() > greatest.getTime()) {
    raw = cursor.prev().toDate();
    const occurrence = resolveCronOccurrence(recurrence, raw);
    if (occurrence.getTime() > greatest.getTime()) greatest = occurrence;
  }
  // During a spring gap the parser's next raw time may resolve back to the
  // first valid instant, which is already due at the observation time.
  const next = resolveCronOccurrence(
    recurrence,
    cronParser(recurrence, previousRaw).next().toDate(),
  );
  if (
    next.getTime() <= observedAt.getTime() &&
    next.getTime() > greatest.getTime()
  )
    greatest = next;
  return greatest;
}

export function resolveScheduleObservation(
  recurrenceInput: ScheduleRecurrence,
  anchorAt: Date,
  observedAt: Date,
): ScheduleObservation {
  const recurrence = parseScheduleRecurrence(recurrenceInput);
  if (
    !Number.isFinite(anchorAt.getTime()) ||
    !Number.isFinite(observedAt.getTime())
  )
    throw new TypeError('Schedule dates must be valid');

  if (recurrence.kind === 'interval') {
    const duration = recurrence.intervalMinutes * 60_000;
    const elapsed = observedAt.getTime() - anchorAt.getTime();
    const dueCount = Math.floor(elapsed / duration);
    const greatestDueAt =
      dueCount < 1 ? null : new Date(anchorAt.getTime() + dueCount * duration);
    return Object.freeze({
      greatestDueAt,
      nextAt: new Date(
        anchorAt.getTime() + Math.max(1, dueCount + 1) * duration,
      ),
    });
  }

  const first = nextCronOccurrence(recurrence, anchorAt);
  if (first.getTime() > observedAt.getTime())
    return Object.freeze({ greatestDueAt: null, nextAt: first });

  return Object.freeze({
    greatestDueAt: greatestCronOccurrence(recurrence, observedAt),
    nextAt: nextCronOccurrence(recurrence, observedAt),
  });
}
