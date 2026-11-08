import { rmSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { parseMaintenanceDatabaseConfig } from '../../../packages/database/dist/platform/index.js';
import { withBackupDeletionPause } from '../../../packages/core/dist/lifecycle/index.js';
import { copySharedObjects, collectSharedObjects } from './shared-objects.mjs';
import { rclone, sourceClient } from './transport.mjs';

const [mode, directory] = process.argv.slice(2);
if (mode === 'collect') {
  await collectSharedObjects(rclone);
} else if (mode === 'capture' && directory) {
  const seconds = process.env.BACKUP_DUMP_TIMEOUT_SECONDS ?? '3600';
  if (!/^[1-9][0-9]*$/u.test(seconds) || Number(seconds) > 86400)
    throw new Error(
      'BACKUP_DUMP_TIMEOUT_SECONDS must be an integer from 1 to 86400',
    );
  // Process exit closes the session even when work or a child transport is stuck.
  const stop = (message) => {
    console.error(message);
    try {
      rmSync(`${directory}/rclone.env`, { force: true });
    } finally {
      process.exit(1);
    }
  };
  const ownerLost = () =>
    stop('Backup shell stdin closed; releasing artifact deletion');
  process.stdin.on('end', ownerLost);
  process.stdin.resume();
  const source = sourceClient(process.env);
  try {
    const initial = await copySharedObjects({
      ...source,
      directory,
      rclone,
      preCopy: true,
    });
    await withBackupDeletionPause(
      parseMaintenanceDatabaseConfig(process.env),
      async () => {
        const deadline = globalThis.setTimeout(
          () =>
            stop(
              'BACKUP_DUMP_TIMEOUT_SECONDS exceeded; releasing artifact deletion',
            ),
          Number(seconds) * 1000,
        );
        await writeFile(`${directory}/capture.ready`, 'ready');
        for (;;) {
          try {
            await access(`${directory}/dump.done`);
            break;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          await setTimeout(100);
        }
        clearTimeout(deadline);
        const final = await copySharedObjects({
          ...source,
          directory,
          rclone,
          knownEntries: initial.entries,
        });
        await writeFile(
          `${directory}/objects.json`,
          JSON.stringify(final.entries),
        );
        await writeFile(
          `${directory}/objects.count`,
          `${final.entries.length}\n`,
        );
        console.log(`Copied ${initial.copied + final.copied} new objects`);
      },
    );
  } finally {
    source.client.destroy();
    process.stdin.removeListener('end', ownerLost);
    process.stdin.pause();
  }
} else throw new Error('usage: capture.mjs capture <directory> | collect');
