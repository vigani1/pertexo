import process from 'node:process';

if (process.release.name !== 'node')
  throw new Error('@pertexo/nodes-core/server is server-only');
