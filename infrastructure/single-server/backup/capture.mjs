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
  }
} else throw new Error('usage: capture.mjs capture <directory> | collect');
