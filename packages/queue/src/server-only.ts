import process from 'node:process';

if (process.release.name !== 'node') {
  throw new Error('@pertexo/queue is server-only');
}
