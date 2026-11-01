import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const run = promisify(execFile);

/** What a production process sees: the built package, by name, without vitest's resolver. */
async function exportsOf(entry: string): Promise<readonly string[]> {
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `process.stdout.write(JSON.stringify(Object.keys(await import(${JSON.stringify(entry)}))))`,
    ],
    { cwd: new URL('../../', import.meta.url) },
  );
  return JSON.parse(stdout) as string[];
}

it('loads the Inbox from its own built entry point', async () => {
  expect(await exportsOf('@pertexo/core/inbox')).toEqual(
    expect.arrayContaining([
      'createWorkspaceInboxStore',
      'createWorkspaceInboxFoldStore',
      'createNoticeMailStore',
      'createNoticePreferencesStore',
    ]),
  );
}, 30_000);

it('no longer hands the Inbox out through notifications', async () => {
  const notifications = await exportsOf('@pertexo/core/notifications');

  expect(notifications).toContain('createNotificationDestinationStore');
  expect(notifications).not.toContain('createWorkspaceInboxStore');
  expect(notifications).not.toContain('createNoticeMailStore');
}, 30_000);
