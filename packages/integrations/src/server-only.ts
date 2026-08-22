import process from 'node:process';

if (process.release.name !== 'node')
  throw new Error('@pertexo/integrations/server is server-only');
