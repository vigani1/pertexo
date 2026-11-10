import { readFile } from 'node:fs/promises';
import { rclone } from './transport.mjs';
import { verifyBackupKey } from './key-check.mjs';

// Prepare and verify on the same transport so automatic retention avoids extra startups.
await import('./prepare.mjs');
await verifyBackupKey();

const directory = process.env.BACKUP_TRANSPORT_DIRECTORY ?? '/backup';
const bucket = await readFile(`${directory}/backup-bucket`, 'utf8');
for (const remote of ['crypt:', `backup:${bucket}`]) {
  const references = await rclone([
    'lsf',
    remote,
    '--recursive',
    '--files-only',
    '--max-depth',
    '3',
    '--include',
    '/pertexo-beta/**/release.txt',
  ]);
  for (const reference of references.split('\n').filter(Boolean)) {
    if (!/^pertexo-beta\/[0-9]{8}T[0-9]{6}Z\/release.txt$/u.test(reference))
      throw new Error('Unexpected recovery reference path; cleanup deferred.');
    const release = (
      await rclone([
        'cat',
        `${remote}${remote.endsWith(':') ? '' : '/'}${reference}`,
      ])
    ).trim();
    if (!/^[0-9a-f]{40}$/u.test(release))
      throw new Error('Invalid recovery release; cleanup deferred.');
    console.log(release);
  }
}
