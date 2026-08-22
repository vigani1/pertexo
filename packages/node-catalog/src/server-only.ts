import process from 'node:process';

if (process.release.name !== 'node')
  throw new Error('@pertexo/node-catalog/server is server-only');
