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
const WRITTEN_LIMIT = new RegExp(
  [
    String.raw`\b\d[\d,.]*\s?(?:KB|MB|GB|TB)\b`,
    String.raw`\b\d[\d,]*\s(?:bytes|characters)\b`,
    String.raw`\b(?:up to|at most|at least|no more than|within|after|for|older than|longer than|valid for|expires? in|lasts?)\s${COUNT}\s(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|characters|entries|items|files|steps|cases|rows|people)\b`,
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

// Limits still written as literals when this check began (batch J6b). Each
// needs its owner; the list may only shrink, so a fixed one fails until it's
// removed, and a new one fails at once.
const STILL_WRITTEN: readonly string[] = [
  'features/api-tokens/forms/create-token.tsx: up to 128 characters',
  'features/api-tokens/model/token-copy.ts: within five minutes',
  'features/artifacts/components/upload-file.tsx: 10 MB',
  'features/artifacts/model/artifact-upload.ts: 10 MB',
  'features/artifacts/model/artifact-upload.ts: 10 MB',
  'features/auth/components/account/link-provider-dialog.tsx: within five minutes',
  'features/auth/components/sign-up-lens.tsx: 256 characters',
  'features/connections/model/connection-health.ts: within 15 seconds',
  'features/connections/model/connection-providers.ts: 128 characters',
  'features/connections/model/credential-draft.ts: 8 bytes',
  'features/connections/model/credential-draft.ts: 8 bytes',
  'features/connections/model/smtp-draft.ts: at most 128 characters',
  'features/data-tables/components/create.tsx: 1 KB',
  'features/data-tables/components/import.tsx: 1 MB',
  'features/data-tables/components/import.tsx: 1 MB',
  'features/data-tables/components/import.tsx: 1 MB',
  'features/data-tables/pages/tables.tsx: 64 KB',
  'features/federation/components/directory/credential-dialog.tsx: up to 128 characters',
  'features/federation/components/organization/create.tsx: up to 128 characters',
  'features/federation/components/providers/provider-form.tsx: 8 bytes',
  'features/federation/components/providers/provider-form.tsx: up to 128 characters',
  'features/federation/components/providers/saml-form.tsx: at most 16,384 characters',
  'features/federation/components/providers/saml-form.tsx: up to 128 characters',
  'features/forms/components/field-editor.tsx: 10 MB',
  'features/forms/components/field-editor.tsx: up to 5 files',
  'features/forms/components/form-history.tsx: for 90 days',
  'features/overview/components/home-loom.tsx: 1 hour',
  'features/overview/components/home-loom.tsx: 24 hours',
  'features/overview/components/home-loom.tsx: 6 hours',
  'features/overview/components/home-loom.tsx: 7 days',
  'features/trigger-events/model/presentation.ts: 512 bytes',
  'features/usage/pages/usage-trends.tsx: 30 days',
  'features/usage/pages/usage-trends.tsx: 90 days',
  'features/usage/pages/workspace-usage.tsx: 1 hour',
  'features/usage/pages/workspace-usage.tsx: 24 hours',
  'features/usage/pages/workspace-usage.tsx: 6 hours',
  'features/usage/pages/workspace-usage.tsx: 7 days',
  'features/workflow-collaboration/components/mention-picker.tsx: up to twenty people',
  'features/workflow-collaboration/forms/comment-form.tsx: up to 8,000 characters',
  'features/workflow-editor/components/inspector/builders/files/sheet-tabs.tsx: up to 31 characters',
  'features/workflow-editor/components/inspector/builders/switch-cases.tsx: 1,024 characters',
  'features/workflow-editor/components/inspector/event-coordination/setup.tsx: 512 bytes',
  'features/workflow-editor/components/inspector/event-coordination/setup.tsx: at most 24 hours',
  'features/workflow-editor/components/inspector/event-coordination/setup.tsx: up to 15 minutes',
  'features/workflow-editor/components/inspector/human-task/context-editor.tsx: 16 KB',
  'features/workflow-editor/components/inspector/human-task/context-editor.tsx: 8 KB',
  'features/workflow-editor/components/inspector/human-task/context-editor.tsx: 8 KB',
  'features/workflow-editor/components/inspector/human-task/context-editor.tsx: up to 160 characters',
  'features/workflow-editor/components/inspector/human-task/text.tsx: at most 2,000 characters',
  'features/workflow-editor/components/inspector/human-task/text.tsx: up to 160 characters',
  'features/workflow-editor/components/inspector/run-values/setup.tsx: 255 characters',
  'features/workflow-editor/components/inspector/run-values/setup.tsx: 50 characters',
  'features/workflow-editor/components/inspector/run-values/setup.tsx: up to 255 characters',
  'features/workflow-editor/components/inspector/run-values/setup.tsx: up to 255 characters',
  'features/workflow-editor/components/inspector/webhook/response-setup.tsx: 1 MB',
  'features/workflow-editor/model/inspector/http-body.ts: 8 bytes',
  'features/workflow-editor/model/inspector/http-body.ts: 8 bytes',
  'features/workflow-editor/model/inspector/schedule-draft.ts: at least one day',
  'features/workflow-publish/components/run-submission/input-dialog.tsx: within 24 hours',
  'features/workflow-publish/data/mutations/use-workflow-run-submission.ts: within 24 hours',
  'features/workflow-runs/components/run-detail/outputs-view.tsx: 1 mb',
  'features/workflow-runs/components/run-detail/outputs-view.tsx: 1 mb',
  'features/workflow-runs/components/run-filters/business-value.tsx: up to 255 characters',
  'features/workflow-runs/data/mutations/use-run-replay.ts: within 24 hours',
  'features/workflow-runs/model/step-inspection/error-copy.ts: 1 MB',
  'features/workflow-runs/model/step-inspection/error-copy.ts: 6 MB',
  'features/workflow-runs/model/step-inspection/error-copy.ts: 64 KB',
  'features/workflow-runs/model/step-inspection/error-copy.ts: At most 1,000 rows',
  'features/workflow-runs/model/step-inspection/error-copy.ts: at most 10 files',
  'features/workflow-settings/components/triggers/schedules/occurrences.tsx: for 90 days',
  'features/workflow-settings/components/triggers/webhooks/deliveries.tsx: for 90 days',
  'features/workflow-settings/model/run-duration.ts: 1 hour',
  'features/workflow-testing/components/test-suites/preparation.tsx: up to 50 cases',
  'features/workflows/components/input-cases/expectations.tsx: 4 KB',
  'features/workflows/components/organization/folders/dialogs.tsx: up to 128 characters',
  'features/workflows/components/organization/tags/management.tsx: up to 32 characters',
  'features/workflows/model/rename.ts: 128 characters',
  'features/workflows/model/templates/curated-setup.ts: 128 characters',
  'features/workflows/model/templates/curated-setup.ts: 2,048 bytes',
  'features/workspaces/components/creation/workspace-creation-form.tsx: up to 128 characters',
  'features/workspaces/components/creation/workspace-creation-form.tsx: up to 64 characters',
  'features/workspaces/components/invitations/email-chips-field.tsx: for seven days',
  'features/workspaces/components/settings/workspace-danger-zone.tsx: for 30 days',
  'features/workspaces/components/settings/workspace-danger-zone.tsx: within 30 days',
  'features/workspaces/components/settings/workspace-danger-zone.tsx: within 30 days',
  'features/workspaces/components/settings/workspace-deletion-dialog.tsx: for 30 days',
  'features/workspaces/components/settings/workspace-deletion-dialog.tsx: up to 512 characters',
  'features/workspaces/components/settings/workspace-name-field.tsx: 128 characters',
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
        ...[...text.matchAll(WRITTEN_LIMIT)].map(([phrase]) => phrase),
        ...(BARE_DURATION.test(text) ? [text.trim()] : []),
      ]
        .filter((phrase) => !TIME_RANGE.test(phrase))
        .map((phrase) => `${relative(root, path)}: ${phrase}`),
    ),
  );
}

it('states limits through their owners, not as written literals', () => {
  const found = writtenLimits(join(import.meta.dirname, '../../src'));
  expect(found.sort()).toEqual([...STILL_WRITTEN].sort());
});
