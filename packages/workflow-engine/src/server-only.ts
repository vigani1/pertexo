import process from 'node:process';

if (process.release.name !== 'node')
  throw new Error('@pertexo/workflow-engine is server-only');
