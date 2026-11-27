import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { copyIn, sources } from './source-copy';

// Limits the browser states (sizes, lengths, how long something lasts or is
// kept) come from the value the server enforces, formatted with
// formatByteLength, formatTimeSpan or formatCount, so copy can't drift from
// what the server does. This reads every string, template part and JSX text
// in src and fails on a limit written as a literal.
const COUNT = String.raw`(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|sixty|ninety)`;
// Size units are capitals, so a class like `mt-1 mb-3` isn't a size. Binary
// units (KiB, MiB) are sizes too.
const WRITTEN_SIZE = /\b\d[\d,.]*\s?[KMGT]i?B\b/gu;
const SPAN = String.raw`(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)`;
const WRITTEN_LIMIT = new RegExp(
  [
    // "4,096 UTF-8 bytes", not the 8 of "UTF-8".
    String.raw`(?<![\w-])\d[\d,]*\s(?:UTF-8\s)?(?:bytes|characters)\b`,
    String.raw`\b(?:up to|at most|at least|no more than|within|after|for|waited|older than|longer than|valid for|expires? in|lasts?)\s${COUNT}\s(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|characters|entries|items|files|steps|cases|rows|people)\b`,
    String.raw`\b${COUNT}\s*[–−-]\s*${COUNT}\s(?:distinct\s)?(?:workflows|items|files|steps|rows|entries)\b`,
    // "From 1 hour to 30 days": a range states both bounds.
    String.raw`\bfrom\s${COUNT}\s${SPAN}\s(?:to|through|and)\s${COUNT}\s${SPAN}`,
    // "Try again in 15 minutes", "the last 30 days", "7 days if you leave
    // it": a wait, a window and a default are limits too.
    String.raw`\bin\s${COUNT}\s${SPAN}`,
    String.raw`\bthe\slast\s${COUNT}\s${SPAN}`,
    String.raw`${COUNT}\s${SPAN}\s(?:if you leave it|by default|unless you)\b`,
    // "the 24-hour retry window": a span written as an adjective.
    String.raw`(?<![\w-])${COUNT}-(?:second|minute|hour|day|week|month|year)\b`,
    // "All 64 rules are in use": a full list says its limit.
    String.raw`\ball\s${COUNT}\s\w+\s(?:are\s)?in use\b`,
  ].join('|'),
  'giu',
);
// A text that is only a duration ("5 minutes") is a limit kept as a word.
const BARE_DURATION = new RegExp(
  String.raw`^\s*${COUNT}\s(?:seconds?|minutes?|hours?|days?|weeks?)\s*$`,
  'iu',
);
// "Last 24 hours" names a time range people choose, not a limit.
const TIME_RANGE = /^last\s/iu;

// Time ranges people choose from (Home's and Usage's window buttons) are a
// choice of period, and "pick at least one day" asks for a weekday choice:
// neither is a limit, so they keep their words.
const NOT_LIMITS: readonly string[] = [
  'features/overview/components/home-loom.tsx: 1 hour',
  'features/overview/components/home-loom.tsx: 24 hours',
  'features/overview/components/home-loom.tsx: 6 hours',
  'features/overview/components/home-loom.tsx: 7 days',
  'features/usage/pages/usage-trends.tsx: 30 days',
  'features/usage/pages/usage-trends.tsx: 90 days',
  'features/workflow-editor/model/inspector/schedule-draft.ts: at least one day',
  // The same window choices, said in a sentence, and the deadline presets.
  'components/ui/deadline-field.tsx: In 1 day',
  'components/ui/deadline-field.tsx: In 1 hour',
  'features/overview/components/home-loom.tsx: the last 24 hours',
  'features/overview/components/home-loom.tsx: the last 6 hours',
  'features/overview/components/home-loom.tsx: the last 7 days',
];

function writtenLimits(root: string): string[] {
  return sources(root).flatMap((path) =>
    copyIn(path).flatMap((text) =>
      [
        ...[...text.matchAll(WRITTEN_SIZE)].map(([phrase]) => phrase),
        ...[...text.matchAll(WRITTEN_LIMIT)].map(([phrase]) => phrase),
        ...(BARE_DURATION.test(text) ? [text.trim()] : []),
      ]
        .filter((phrase) => !TIME_RANGE.test(phrase))
        .map((phrase) => `${relative(root, path)}: ${phrase}`),
    ),
  );
}

it('states limits through their owners, not as written literals', () => {
  const found = writtenLimits(join(import.meta.dirname, '../../src')).sort();
  expect(found).toEqual([...NOT_LIMITS].sort());
});
