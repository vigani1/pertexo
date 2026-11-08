import { readFile } from 'node:fs/promises';
import {
  parseObjectManifest,
  restoreSharedObjects,
} from './shared-objects.mjs';
import { sourceClient, rclone } from './transport.mjs';
const [mode, directory] = process.argv.slice(2);
const entries = parseObjectManifest(
  await readFile(`${directory}/objects.json`, 'utf8'),
);
if (mode === 'validate') console.log(entries.length);
else if (mode === 'restore') {
  const source = sourceClient(process.env);
  try {
    console.log(
      await restoreSharedObjects({ ...source, directory, entries, rclone }),
    );
  } finally {
    source.client.destroy();
  }
} else
  throw new Error('usage: restore-objects.mjs validate|restore <directory>');
