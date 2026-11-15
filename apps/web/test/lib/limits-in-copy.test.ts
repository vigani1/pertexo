import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Limits the browser states (sizes, lengths, how long something lasts or is
// kept) come from the value the server enforces, formatted with
// formatByteLength, formatTimeSpan or formatCount, so copy can't drift from
// what the server does. This reads every string, template part and JSX text
// in src and fails on a limit written as a literal.
const COUNT = String.raw`(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|sixty|ninety)`;
// Size units are capitals, so a class like `mt-1 mb-3` isn't a size. Binary
// units (KiB, MiB) are sizes too.
const WRITTEN_SIZE = /\b\d[\d,.]*\s?[KMGT]i?B\b/gu;
const WRITTEN_LIMIT = new RegExp(
  [
    // "4,096 UTF-8 bytes", not the 8 of "UTF-8".
    String.raw`(?<![\w-])\d[\d,]*\s(?:UTF-8\s)?(?:bytes|characters)\b`,
    String.raw`\b(?:up to|at most|at least|no more than|within|after|for|older than|longer than|valid for|expires? in|lasts?)\s${COUNT}\s(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|characters|entries|items|files|steps|cases|rows|people)\b`,
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
  'features/usage/pages/workspace-usage.tsx: 1 hour',
  'features/usage/pages/workspace-usage.tsx: 24 hours',
  'features/usage/pages/workspace-usage.tsx: 6 hours',
  'features/usage/pages/workspace-usage.tsx: 7 days',
  'features/workflow-editor/model/inspector/schedule-draft.ts: at least one day',
];

// Limits still written as literals when this check began (batch J6b). Each
// needs its owner; the list may only shrink, so a fixed one fails until it's
// removed, and a new one fails at once. Those left are enforced only by the
// API, worker or core (the fresh sign-in window, command retries, invitation
// and deletion windows, trigger history, the connection test's wait and the
// sign-up name), which have no browser-safe constant yet.
const STILL_WRITTEN: readonly string[] = [
  'features/api-tokens/model/token-copy.ts: within five minutes',
  'features/auth/components/account/link-provider-dialog.tsx: within five minutes',
  'features/auth/components/sign-up-lens.tsx: 256 characters',
  'features/connections/model/connection-health.ts: within 15 seconds',
  'features/forms/components/form-history.tsx: for 90 days',
  'features/workflow-publish/components/run-submission/input-dialog.tsx: within 24 hours',
  'features/workflow-publish/data/mutations/use-workflow-run-submission.ts: within 24 hours',
  'features/workflow-runs/data/mutations/use-run-replay.ts: within 24 hours',
  'features/workflow-settings/components/triggers/schedules/occurrences.tsx: for 90 days',
  'features/workflow-settings/components/triggers/webhooks/deliveries.tsx: for 90 days',
  'features/workspaces/components/invitations/email-chips-field.tsx: for seven days',
  'features/workspaces/components/settings/workspace-danger-zone.tsx: for 30 days',
  'features/workspaces/components/settings/workspace-danger-zone.tsx: within 30 days',
  'features/workspaces/components/settings/workspace-danger-zone.tsx: within 30 days',
  'features/workspaces/components/settings/workspace-deletion-dialog.tsx: for 30 days',
  'features/workspaces/components/shell/workspace-banners.tsx: for 30 days',
  'features/workspaces/data/mutations/members/use-member-command.ts: within five minutes',
];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

/** Every piece of text a file shows: strings, template parts and JSX text. */
function copyIn(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      texts.push(node.text);
    else if (ts.isJsxText(node)) texts.push(node.text.replace(/\s+/gu, ' '));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

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
  expect(found).toEqual([...NOT_LIMITS, ...STILL_WRITTEN].sort());
});
