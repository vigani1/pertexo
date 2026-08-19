import process from 'node:process';

if (process.release.name !== 'node') {
  throw new Error('@pertexo/artifact-store is server-only');
}
